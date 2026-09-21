import os
import json
import logging
import time
import base64
import io
import boto3
from decimal import Decimal
from boto3.dynamodb.conditions import Key
from PIL import Image
from typing import Dict, Any, Optional

def invoke_agentcore_gateway_tool(tool_name: str, arguments: dict):
    """Invoke a tool exposed by the Bedrock AgentCore Gateway using AWS SigV4."""
    gateway_url = os.environ.get("McpServerGatewayUrl", "").strip()
    if not gateway_url:
        return
        
    try:
        import requests
        import urllib.parse
        from botocore.auth import SigV4Auth
        from botocore.awsrequest import AWSRequest
        from botocore.session import Session
        
        session = Session()
        credentials = session.get_credentials().get_frozen_credentials()
        region = session.get_config_variable('region') or os.environ.get("AWS_REGION", "us-east-1")
        
        payload = json.dumps({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": tool_name,
                "arguments": arguments
            }
        }).encode('utf-8')
        
        post_request = AWSRequest(method="POST", url=gateway_url, data=payload)
        SigV4Auth(credentials, "bedrock-agentcore", region).add_auth(post_request)
        
        headers = dict(post_request.headers)
        headers['Content-Type'] = 'application/json'
        headers['Accept'] = 'application/json'
        
        post_response = requests.post(gateway_url, data=payload, headers=headers, timeout=15)
        
        if post_response.status_code == 200:
            logger.info(f"AgentCore gateway invocation successful for tool: {tool_name}")
            return post_response.text
        else:
            logger.error(f"AgentCore gateway tool call failed: {post_response.status_code} {post_response.text}")
            
    except Exception as e:
        logger.error(f"Failed to invoke AgentCore gateway tool {tool_name}: {e}")

# Configure Logger
logger = logging.getLogger()
logger.setLevel(getattr(logging, os.environ.get("LOG_LEVEL", "INFO").upper(), logging.INFO))

connections_table_name = os.environ.get("CONNECTIONS_TABLE", "DomainExpansionConnections")
sessions_table_name = os.environ.get("SESSIONS_TABLE", "DomainExpansionSessions")

dynamodb = boto3.resource("dynamodb")
connections_table = dynamodb.Table(connections_table_name)
sessions_table = dynamodb.Table(sessions_table_name)

# Agent Configuration Defaults
DEFAULT_AGENT_TYPE = os.environ.get("AGENT_TYPE", "agentcore_runtime")

def normalize_json_value(value):
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, dict):
        return {k: normalize_json_value(v) for k, v in value.items()}
    if isinstance(value, list):
        return [normalize_json_value(v) for v in value]
    return value


def optimize_commentary_image(image_bytes, max_dimension=640, quality=70):
    if not image_bytes:
        return image_bytes

    try:
        with Image.open(io.BytesIO(image_bytes)) as image:
            original_size = image.size
            normalized = image.convert("RGB")
            normalized.thumbnail((max_dimension, max_dimension), Image.Resampling.LANCZOS)

            output = io.BytesIO()
            normalized.save(output, format="JPEG", quality=quality, optimize=True)
            optimized_bytes = output.getvalue()

            logger.info(
                "Optimized commentary image from %s (%d bytes) to %s (%d bytes)",
                original_size,
                len(image_bytes),
                normalized.size,
                len(optimized_bytes),
            )
            return optimized_bytes
    except Exception as exc:
        logger.warning("Failed to optimize commentary image, using original bytes: %s", exc)
        return image_bytes

def dispatch_event(
    event,
    context,
    *,
    authorizer=None,
    sqs_handler=None,
    websocket_handler=None,
    http_handler=None,
):
    logger.info(f"Incoming Event: {json.dumps(event)}")
    
    # 0. Check for API Gateway Custom Authorizer REQUEST payload
    if event.get("type") == "REQUEST" and "methodArn" in event:
        if authorizer is None:
            from auth import auth_handler

            authorizer = auth_handler
        return authorizer(event, context)
    
    # 1. Check for SQS Trigger
    if "Records" in event:
        if sqs_handler is None:
            from image_processor import handle_sqs_image_gen

            sqs_handler = handle_sqs_image_gen
        for record in event["Records"]:
            if record.get("eventSource") == "aws:sqs":
                try:
                    sqs_handler(record)
                except Exception as e:
                    logger.error(f"SQS generation failed: {e}")
        return {"statusCode": 200, "body": "SQS Records processed."}
    
    # 2. Detect WebSocket API Gateway connection
    request_context = event.get("requestContext", {})
    if "connectionId" in request_context:
        return (websocket_handler or handle_websocket)(event, request_context)
        
    # 3. Treat as HTTP API Gateway REST call
    return (http_handler or handle_http)(event)


def lambda_handler(event, context):
    """AWS Lambda entry point."""
    return dispatch_event(event, context)


# WebSocket API Handler
def handle_websocket(event, r_ctx):
    connection_id = r_ctx.get("connectionId")
    route_key = r_ctx.get("routeKey")
    logger.info(f"WebSocket Connection ID: {connection_id}, Route Key: {route_key}")

    # Initialize API Gateway Management client to send messages back
    domain = r_ctx.get("domainName")
    stage = r_ctx.get("stage")
    ws_endpoint = f"https://{domain}/{stage}"
    apigw_client = boto3.client("apigatewaymanagementapi", endpoint_url=ws_endpoint)

    def post_to_conn(target_conn_id, data):
        try:
            apigw_client.post_to_connection(
                ConnectionId=target_conn_id,
                Data=json.dumps(data)
            )
        except Exception as e:
            logger.warning(f"Could not post to connection {target_conn_id}: {e}")

    def query_room_connections(room_code):
        try:
            # Query index RoomCodeIndex
            response = connections_table.query(
                IndexName="RoomCodeIndex",
                KeyConditionExpression=Key("room_code").eq(room_code)
            )
            return response.get("Items", [])
        except Exception as e:
            logger.error(f"Error querying room connections: {e}")
            return []

    if route_key == "$connect":
        logger.info(f"Client connected: {connection_id}")
        return {"statusCode": 200, "body": "Connected."}

    elif route_key == "$disconnect":
        logger.info(f"Client disconnected: {connection_id}")
        # Look up room code before deletion
        try:
            record_resp = connections_table.get_item(Key={"connection_id": connection_id})
            record = record_resp.get("Item")
            if record:
                room_code = record.get("room_code")
                client_id = record.get("client_id")
                role = record.get("role")
                
                # Delete connection
                connections_table.delete_item(Key={"connection_id": connection_id})
                
                # Broadcast departure
                room_conns = query_room_connections(room_code)
                for conn in room_conns:
                    target_id = conn.get("connection_id")
                    if target_id != connection_id:
                        post_to_conn(target_id, {
                            "type": "user_left",
                            "data": {
                                "id": client_id,
                                "role": role
                            }
                        })
        except Exception as e:
            logger.error(f"Error during disconnect cleanup: {e}")
        return {"statusCode": 200, "body": "Disconnected."}

    # Custom WebSocket action handler
    try:
        body = json.loads(event.get("body", "{}"))
        action = body.get("action")
        logger.info(f"WebSocket custom action parsed: {action}")

        if action == "join_room":
            room_code = body.get("roomCode", "BTL1")
            role = body.get("role", "viewer")
            client_id = body.get("client_id", "anonymous")

            # Save connection mapping
            connections_table.put_item(
                Item={
                    "connection_id": connection_id,
                    "client_id": client_id,
                    "room_code": room_code,
                    "role": role,
                    "created_at": int(time.time())
                }
            )
            logger.info(f"Saved connection mapping: {connection_id} -> Room: {room_code}, Role: {role}")

            # Notify all other room participants
            room_conns = query_room_connections(room_code)
            for conn in room_conns:
                target_id = conn.get("connection_id")
                if target_id != connection_id:
                    post_to_conn(target_id, {
                        "type": "user_joined",
                        "data": {
                            "id": client_id,
                            "role": role
                        }
                    })

        elif action == "signal":
            sig_type = body.get("type")
            sig_data = body.get("data")
            to_client = body.get("to")

            # Find sender's parameters
            sender_resp = connections_table.get_item(Key={"connection_id": connection_id})
            sender = sender_resp.get("Item")
            if not sender:
                logger.warning(f"Sender connection mapping missing: {connection_id}")
                return {"statusCode": 404, "body": "Sender missing"}

            sender_id = sender.get("client_id")
            sender_role = sender.get("role")
            room_code = sender.get("room_code")

            payload = {
                "type": "signal",
                "data": {
                    "from": sender_id,
                    "role": sender_role,
                    "type": sig_type,
                    "data": sig_data
                }
            }

            if to_client:
                # Direct Unicast to specified client_id
                room_conns = query_room_connections(room_code)
                for conn in room_conns:
                    if conn.get("client_id") == to_client:
                        post_to_conn(conn.get("connection_id"), payload)
            else:
                # Broadcast to everyone else in the room
                room_conns = query_room_connections(room_code)
                for conn in room_conns:
                    target_id = conn.get("connection_id")
                    if target_id != connection_id:
                        post_to_conn(target_id, payload)

    except Exception as e:
        logger.error(f"WebSocket custom handler failed: {e}")
        return {"statusCode": 500, "body": f"Error: {e}"}

    return {"statusCode": 200, "body": "OK"}


JJK_ACTION_MAP = {
    "domain_unlimited_void": {
        "stance": "kung_fu",
        "speech": "領域展開、無量空処",
        "language": "ja"
    },
    "domain_malevolent_shrine": {
        "stance": "right_uppercut",
        "speech": "領域展開、伏魔御厨子",
        "language": "ja"
    },
    "domain_self_embodiment": {
        "stance": "twist",
        "speech": "領域展開、自閉円頓裹",
        "language": "ja"
    },
    "domain_authentic_love": {
        "stance": "wave",
        "speech": "領域展開、真贋相愛",
        "language": "ja"
    },
    "domain_idle_death_gamble": {
        "stance": "dance",
        "speech": "領域展開、坐殺博徒",
        "language": "ja"
    },
    "domain_yuji_itadori": {
        "stance": "punch",
        "speech": "領域展開",
        "language": "ja"
    },
    "domain_chimera_shadow_garden": {
        "stance": "squat",
        "speech": "領域展開、嵌合暗翳庭",
        "language": "ja"
    },
    "domain_time_cell_moon_palace": {
        "stance": "twist",
        "speech": "領域展開、時胞月宮殿",
        "language": "ja"
    },
    "lapse_blue": {
        "stance": "left_shot_fast",
        "speech": "術式順転、蒼",
        "language": "ja"
    },
    "reversal_red": {
        "stance": "right_shot_fast",
        "speech": "術式反転、赫",
        "language": "ja"
    },
    "hollow_purple": {
        "stance": "kick",
        "speech": "虚式、茈",
        "language": "ja"
    }
}


# HTTP REST API Handler
def handle_http(event):
    path = event.get("path", "")
    method = event.get("httpMethod", "GET")
    logger.info(f"REST Route: {method} {path}")

    # Standard JSON CORS Headers
    headers = {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST,GET,OPTIONS"
    }

    if method == "OPTIONS":
        return {"statusCode": 200, "headers": headers, "body": ""}

    if path == "/health":
        return {"statusCode": 200, "headers": headers, "body": json.dumps({"status": "healthy"})}

    def snapshot_exists_for_session(session_id, role):
        photos_bucket = os.environ.get("PHOTOS_S3_BUCKET")
        if not photos_bucket:
            return False
        try:
            boto3.client("s3").head_object(
                Bucket=photos_bucket,
                Key=f"webcam_snapshots/{session_id}/{role}.jpg"
            )
            return True
        except Exception:
            return False

    try:
        body = json.loads(event.get("body", "{}")) if event.get("body") else {}
    except Exception:
        body = {}

    # Endpoint: /api/enhance-portrait (POST)
    if path == "/api/enhance-portrait" and method == "POST":
        session_id = body.get("sessionId", "mcpserver")
        if not session_id or not isinstance(session_id, str) or not session_id.strip():
            session_id = "mcpserver"
        else:
            session_id = session_id.strip()
            
        template_id = body.get("templateId", "random")
        logger.info(f"Enhance portrait triggered: session={session_id}, template={template_id}")
        debug = {
            "sessionId": session_id,
            "templateId": template_id,
            "awsImageGenerationEnabled": False,
            "photosBucketConfigured": bool(os.environ.get("PHOTOS_S3_BUCKET")),
            "hasSnapshotP1": snapshot_exists_for_session(session_id, "player1"),
            "hasSnapshotP2": snapshot_exists_for_session(session_id, "player2"),
        }

        disabled_status = "ERROR: AWS_IMAGE_GENERATION_DISABLED"

        try:
            sessions_table.update_item(
                Key={"session_id": session_id},
                UpdateExpression="SET enhanced_image_url = :status, updated_at = :t",
                ExpressionAttributeValues={
                    ":status": disabled_status,
                    ":t": int(time.time())
                }
            )
        except Exception as e:
            logger.error(f"Failed to update DynamoDB session state: {e}")
            return {"statusCode": 500, "headers": headers, "body": json.dumps({"error": f"Database lock failed: {e}"})}

        return {
            "statusCode": 200,
            "headers": headers,
            "body": json.dumps({"success": True, "status": disabled_status, "debug": debug})
        }

    # Endpoint: /api/check-enhancement (GET)
    elif path == "/api/check-enhancement" and method == "GET":
        q_params = event.get("queryStringParameters", {}) or {}
        session_id = q_params.get("sessionId", "mcpserver")
        if not session_id or not isinstance(session_id, str) or not session_id.strip():
            session_id = "mcpserver"
        else:
            session_id = session_id.strip()
            
        logger.info(f"Check enhancement status for session={session_id}")

        try:
            resp = sessions_table.get_item(Key={"session_id": session_id})
            item = resp.get("Item", {})
            enhanced_url = item.get("enhanced_image_url", "")
            
            status = "NONE"
            if enhanced_url == "PENDING":
                status = "PENDING"
            elif isinstance(enhanced_url, str) and enhanced_url.startswith("ERROR:"):
                status = enhanced_url
            elif enhanced_url:
                status = "COMPLETE"

            return {
                "statusCode": 200,
                "headers": headers,
                "body": json.dumps(normalize_json_value({
                    "success": True,
                    "status": status,
                    "url": enhanced_url if status == "COMPLETE" else "",
                    "debug": {
                        "sessionFound": bool(item),
                        "rawEnhancedImageValue": enhanced_url,
                        "updatedAt": item.get("updated_at"),
                    }
                }))
            }
        except Exception as e:
            logger.error(f"Failed to fetch session status: {e}")
            return {"statusCode": 500, "headers": headers, "body": json.dumps({"error": str(e)})}

    # Endpoint: /api/get-snapshot (GET)
    elif path == "/api/get-snapshot" and method == "GET":
        q_params = event.get("queryStringParameters", {}) or {}
        session_id = q_params.get("sessionId", "mcpserver")
        if not session_id or not isinstance(session_id, str) or not session_id.strip():
            session_id = "mcpserver"
        else:
            session_id = session_id.strip()
            
        role = q_params.get("role", "player1")
        logger.info(f"Get snapshot triggered (S3-Direct): session={session_id}, role={role}")

        try:
            photos_bucket = os.environ.get("PHOTOS_S3_BUCKET")
            s3_client = boto3.client("s3")
            
            if not photos_bucket:
                raise Exception("PHOTOS_S3_BUCKET env variable is missing!")

            role_key = "player1" if role == "player1" else "player2" if role == "player2" else "viewer"
            s3_key = f"webcam_snapshots/{session_id}/{role_key}.jpg"
            
            try:
                # Direct check if object exists in S3
                s3_client.head_object(Bucket=photos_bucket, Key=s3_key)
                photos_domain = os.environ.get('PHOTOS_S3_DOMAIN', f"{photos_bucket}.s3.amazonaws.com")
                img_url = f"https://{photos_domain}/{s3_key}"
                return {
                    "statusCode": 200,
                    "headers": headers,
                    "body": json.dumps({
                        "success": True,
                        "image": img_url,
                        "message": "Snapshot retrieved from S3"
                    })
                }
            except s3_client.exceptions.ClientError as e:
                # Code 404 indicates object does not exist yet
                logger.info(f"webcam snapshot not found in S3 yet: Bucket={photos_bucket}, Key={s3_key}")
                return {
                    "statusCode": 200,
                    "headers": headers,
                    "body": json.dumps({
                        "success": False,
                        "image": "",
                        "message": "Awaiting snapshot capture"
                    })
                }
        except Exception as e:
            logger.error(f"Error fetching snapshot from S3: {e}")
            return {
                "statusCode": 200, # Return 200 to avoid console warnings, but success=False
                "headers": headers,
                "body": json.dumps({"success": False, "error": str(e)})
            }

    # Endpoint: /api/register-room
    elif path == "/api/register-room" and method == "POST":
        session_id = body.get("sessionId", "mcpserver")
        room_code = body.get("roomCode", "BTL1")
        signaling_url = body.get("signalingUrl", "")

        sessions_table.put_item(
            Item={
                "session_id": session_id,
                "room_code": room_code,
                "signaling_url": signaling_url,
                "updated_at": int(time.time())
            }
        )
        return {
            "statusCode": 200,
            "headers": headers,
            "body": json.dumps({"success": True, "message": f"Session {session_id} mapped to room {room_code}"})
        }

    # Endpoint: /api/webcam-upload
    elif path == "/api/webcam-upload" and method == "POST":
        session_id = body.get("sessionId", "mcpserver")
        role = body.get("role", "player1")
        image_base64 = body.get("image", "")

        try:
            if "," in image_base64:
                _, image_base64 = image_base64.split(",", 1)
            img_data = base64.b64decode(image_base64)
            logger.info("Decoded webcam upload for session=%s role=%s size=%d bytes", session_id, role, len(img_data))
            
            photos_bucket = os.environ.get("PHOTOS_S3_BUCKET")
            s3_client = boto3.client("s3")
            
            if not photos_bucket:
                raise Exception("PHOTOS_S3_BUCKET is missing! S3 storage is required.")

            role_key = "player1" if role == "player1" else "player2" if role == "player2" else "viewer"
            s3_key = f"webcam_snapshots/{session_id}/{role_key}.jpg"
            
            # Write raw image binary directly to S3 bucket
            s3_client.put_object(
                Bucket=photos_bucket,
                Key=s3_key,
                Body=img_data,
                ContentType="image/jpeg"
            )
            photos_domain = os.environ.get('PHOTOS_S3_DOMAIN', f"{photos_bucket}.s3.amazonaws.com")
            img_url = f"https://{photos_domain}/{s3_key}"
            logger.info(f"Successfully saved webcam frame directly to S3 (no DynamoDB storage): {img_url}")

            # Keep DynamoDB record thin - only update the updated_at timestamp!
            sessions_table.update_item(
                Key={"session_id": session_id},
                UpdateExpression="SET updated_at = :t",
                ExpressionAttributeValues={
                    ":t": int(time.time())
                }
            )
            
            return {
                "statusCode": 200,
                "headers": headers,
                "body": json.dumps({
                    "success": True, 
                    "message": "Webcam frame uploaded directly to S3 successfully", 
                    "url": img_url
                })
            }
        except Exception as e:
            logger.error(f"Error uploading image directly to S3: {e}")
            return {"statusCode": 500, "headers": headers, "body": json.dumps({"error": str(e)})}

    # Endpoint: /api/log
    elif path == "/api/log" and method == "POST":
        level = body.get("level", "INFO")
        message = body.get("message", "")
        logger.info(f"[BROWSER_LOG] [{level}] {message}")
        return {"statusCode": 200, "headers": headers, "body": json.dumps({"logged": True})}

    # Endpoint: /api/last-image
    elif path == "/api/last-image" and method == "GET":
        q_params = event.get("queryStringParameters", {}) or {}
        session_id = q_params.get("session_id", "mcpserver")
        role = q_params.get("role", "")

        html_headers = {"Content-Type": "text/html"}
        try:
            photos_bucket = os.environ.get("PHOTOS_S3_BUCKET")
            s3_client = boto3.client("s3")
            
            if not photos_bucket:
                raise Exception("PHOTOS_S3_BUCKET is missing!")

            role_key = "player1" if role == "player1" else "player2" if role == "player2" else "viewer"
            s3_key = f"webcam_snapshots/{session_id}/{role_key}.jpg"

            # Check S3 directly!
            s3_client.head_object(Bucket=photos_bucket, Key=s3_key)
            photos_domain = os.environ.get('PHOTOS_S3_DOMAIN', f"{photos_bucket}.s3.amazonaws.com")
            img_url = f"https://{photos_domain}/{s3_key}"
            
            html_content = f"""
            <html>
            <head>
                <title>Latest Webcam Capture</title>
                <meta http-equiv="refresh" content="2">
                <style>
                    body {{
                        background: #111; color: #fff; text-align: center; font-family: sans-serif; margin: 0; padding: 20px;
                    }}
                    img {{
                        max-width: 95%; max-height: 85vh; border: 4px solid #FFFF00; border-radius: 12px; box-shadow: 0 0 30px rgba(255,255,0,0.2);
                    }}
                    h4 {{ color: #aaa; margin: 10px 0 0 0; letter-spacing: 2px; }}
                </style>
            </head>
            <body>
                <img src="{img_url}">
                <h4>LIVE MATCH snapshot: {session_id} ({role or "active"})</h4>
            </body>
            </html>
            """
            return {"statusCode": 200, "headers": html_headers, "body": html_content}
        except Exception as e:
            return {
                "statusCode": 200,
                "headers": html_headers,
                "body": "<html><head><meta http-equiv='refresh' content='2'></head><body><h3>No webcam frame uploaded yet. Refreshing...</h3></body></html>"
            }

    # Endpoint: /api/live-status
    elif path in ["/api/live-status", "/api/battle-result"] and method == "POST":
        from commentary import translate_detail, generate_ai_commentary
        from commentary_tts import synthesize_commentary_audio
        
        session_id = body.get("sessionId", "mcpserver")
        room_code = body.get("roomCode", "BTL1")
        p1_score = body.get("p1Score", 0)
        p2_score = body.get("p2Score", 0)
        text_event = body.get("text") or body.get("detail") or ""
        event_type = body.get("eventType", "")
        agent_image_policy = body.get("agentImagePolicy", "always")
        foul_language = bool(body.get("foulLanguage", False))
        requested_tts_mode = str(body.get("ttsMode", "browser")).strip().lower()
        if requested_tts_mode not in {"browser", "aws"}:
            requested_tts_mode = "browser"
        commentary_language = body.get("lang", "en")
        is_reset = bool(body.get("isReset", False)) or event_type == "RESET" or path == "/api/battle-result"

        logger.info(
            f"Live-status: session={session_id}, eventType={event_type}, event={text_event}, "
            f"reset={is_reset}, policy={agent_image_policy}, foul={foul_language}"
        )

        # Execute localized JJK translation
        translated_event = translate_detail(text_event)
        tone_directive = (
            "Swearing / trash-talk mode is ACTIVE. You may use sharp Cantonese vulgarities or hard roasts if it fits Nobara's voice."
            if foul_language else
            "Swearing / foul language is STRICTLY FORBIDDEN and OFF (FOUL PROTECTION IS ACTIVE). "
            "You must keep the commentary completely clean, family-friendly, and strictly PG-rated. "
            "You are absolutely prohibited from using any Cantonese vulgarities, swear words, profanities, or offensive slang "
            "including but not limited to: 仆街 (puk gaai), 屌 (diu), 頂你個肺 (ding nei go fai), 戇尻/戇鳩/戇c (on gau), 柒/𨳍 (cat), 撚/𨶙 (lan), 閪/閪人 (hai), 冚家鏟, 廢柴, or any euphemisms/homophones of these words (such as 玩撚, 含撚, 傻西, 傻嗨, 小你, 頂你). "
            "Do not use any English profanity or curse words (e.g., fuck, shit, bitch, damn, hell, crap, asshole). "
            "Your roasts must be creative, humorous, and sassy without resorting to any vulgarity or abusive insults. "
            "Perform a strict self-censorship check on your output to ensure 100% compliance."
        )

        # Build prompt content block
        if path == "/api/battle-result":
            content_block = f"""
[BATTLE CONCLUSION TRIGGERED]
Final Match Results:
- Player 1 Score: {p1_score} points
- Player 2 Score: {p2_score} points
Summary description of final action: {translated_event}
Tone rule: {tone_directive}

If player snapshots are attached, do NOT explain, analyze, or describe the images first. Do NOT output any introductory description of what you see in the images. Incorporate any visual details or roasts silently and naturally into your final commentary dialogue. Give a spectacular, sass-filled, high-octane commentary conclusion. Declare the victor or roast them both if it's a draw. Be Kugisaki Nobara, feisty and fashionable! Keep it to 2 sentences!
"""
        elif is_reset:
            content_block = f"""
[MATCH INITIAL GREETING]
Tone rule: {tone_directive}
Introduce yourself as the supreme JJK Commentator (Kugisaki Nobara). Give a high-energy, confident greeting to the competitors starting their duel in Room {room_code}. The match has NOT started yet, so make this a pre-battle hype introduction before the countdown begins. If player snapshots are attached, do NOT explain, analyze, or describe the images first. Do NOT output any scaffolding (such as 'I can see the snapshots' or 'From P1's image'). Naturally and silently incorporate one or two specific visible details about each player's expression, stance, outfit, or readiness directly into your roleplay introduction dialogue. Tell them to prepare their cursed energy. Sassy, feisty, stylish! Keep it to 2 short sentences!
"""
        else:
            content_block = f"""
[MID-MATCH EVENT ENCOUNTERED]
Current Scores:
- Player 1 Score: {p1_score}
- Player 2 Score: {p2_score}
Latest Match Action: {translated_event}
Tone rule: {tone_directive}

If player snapshots are attached, do NOT explain, analyze, or describe the images first. Do NOT output any introductory text or scaffolding about what you see in the images. React instantly to this specific action! Give sassy, feisty sorcerer trash-talk or hype up the battle with extreme energy. Speak directly to them like an arrogant fashion-lover. Keep it to 2 short, punchy sentences max!
"""

        # Select language directive
        lang_directives = {
            "zh-HK": (
                "IMPORTANT LANGUAGE CONSTRAINT: You must output the entire response in a hybrid of energetic Cantonese (廣東話) "
                "with occasional sassy English and Japanese JJK terms. Format strictly in traditional Chinese characters with "
                "local Hong Kong/Guangdong slang expressions! Do not use simplified characters."
            ),
            "zh-TW": (
                "IMPORTANT LANGUAGE CONSTRAINT: You must output the entire response in a hybrid of energetic Traditional Chinese (繁體中文) "
                "with Taiwan slang/idioms. Do not use simplified characters."
            ),
            "ja": (
                "IMPORTANT LANGUAGE CONSTRAINT: You must output the entire response in natural, energetic, sassy Japanese (日本語) "
                "with occasional English/JJK terminology. Format strictly in standard Japanese text."
            ),
            "en": (
                "IMPORTANT LANGUAGE CONSTRAINT: You must output the entire response in natural, energetic, sassy English (英語) "
                "with standard JJK terms. Do not use Chinese characters."
            )
        }
        
        lang_directive = lang_directives.get(commentary_language)
        if not lang_directive:
            if commentary_language.startswith("zh"):
                lang_directive = lang_directives["zh-HK"]
            elif commentary_language.startswith("ja"):
                lang_directive = lang_directives["ja"]
            else:
                lang_directive = lang_directives["en"]
                
        formatting_directive = (
            "CRITICAL FORMATTING CONSTRAINT: Output ONLY the direct match commentary dialogue "
            "as Kugisaki Nobara. Do NOT write any introductory analysis, do NOT explain what you "
            "see in the snapshots, do NOT think out loud, and do NOT output any conversational scaffolding "
            "(such as 'Now let me provide...' or 'From the images...'). Start directly with the commentary."
        )
        content_block = content_block.strip() + f"\n\n{lang_directive}\n\n{formatting_directive}"

        # Try to retrieve the latest webcam frames for multimodal analysis
        image_bytes_p1 = None
        image_bytes_p2 = None
        image_format_p1 = "jpeg"
        image_format_p2 = "jpeg"
        image_base64_p1 = ""
        image_base64_p2 = ""
        
        # Decide if we should attach image based on policy
        should_attach_image = False
        if agent_image_policy == "always":
            should_attach_image = True
        elif agent_image_policy == "start_end":
            should_attach_image = is_reset or path == "/api/battle-result"

        if should_attach_image:
            try:
                s3_client = boto3.client("s3")
                photos_bucket = os.environ.get("PHOTOS_S3_BUCKET")

                if photos_bucket:
                    # Fetch Player 1 frame directly from S3
                    try:
                        s3_obj = s3_client.get_object(Bucket=photos_bucket, Key=f"webcam_snapshots/{session_id}/player1.jpg")
                        image_bytes_p1 = s3_obj["Body"].read()
                        if image_bytes_p1:
                            image_bytes_p1 = optimize_commentary_image(image_bytes_p1)
                            image_base64_p1 = base64.b64encode(image_bytes_p1).decode("utf-8")
                            logger.info("Successfully fetched Player 1 frame directly from S3 for Bedrock!")
                    except Exception as e:
                        logger.info(f"Could not fetch Player 1 snapshot: {e}")

                    # Fetch Player 2 frame directly from S3
                    try:
                        s3_obj = s3_client.get_object(Bucket=photos_bucket, Key=f"webcam_snapshots/{session_id}/player2.jpg")
                        image_bytes_p2 = s3_obj["Body"].read()
                        if image_bytes_p2:
                            image_bytes_p2 = optimize_commentary_image(image_bytes_p2)
                            image_base64_p2 = base64.b64encode(image_bytes_p2).decode("utf-8")
                            logger.info("Successfully fetched Player 2 frame directly from S3 for Bedrock!")
                    except Exception as e:
                        logger.info(f"Could not fetch Player 2 snapshot: {e}")
                else:
                    logger.warning("PHOTOS_S3_BUCKET is missing! Cannot attach images to commentary.")
            except Exception as e:
                logger.warning(f"Failed to fetch session webcam frames from S3 for Bedrock: {e}")

        # Resolve Commentary Engine
        agent_engine = body.get("agent_type", DEFAULT_AGENT_TYPE)
        logger.info(f"Invoking Commentary Engine: {agent_engine}")

        commentary_text = generate_ai_commentary(
            agent_engine=agent_engine,
            content_block=content_block,
            session_id=session_id,
            image_bytes_p1=image_bytes_p1,
            image_format_p1=image_format_p1,
            image_bytes_p2=image_bytes_p2,
            image_format_p2=image_format_p2,
            image_base64_p1=image_base64_p1,
            image_base64_p2=image_base64_p2,
            language=commentary_language
        )

        # ALWAYS call digital human (xiaoice) speak for strand local, agentcore, and openclaw responses
        if commentary_text and agent_engine in ("strands_local", "agentcore_runtime", "openclaw"):
            invoke_agentcore_gateway_tool(
                tool_name="digital-human-mcp-lambda___digital_human_speech",
                arguments={"message": commentary_text}
            )

        audio_payload = None
        resolved_tts_mode = "browser"
        if requested_tts_mode == "aws":
            audio_payload = synthesize_commentary_audio(
                text=commentary_text,
                session_id=session_id,
                language=commentary_language,
            )
            if audio_payload:
                resolved_tts_mode = "aws"
            else:
                logger.warning("Commentary Polly synthesis failed. Falling back to browser TTS.")

        response_body = {
            "commentary": commentary_text,
            "ttsMode": resolved_tts_mode,
            "requestedTtsMode": requested_tts_mode,
            "debugPrompt": content_block,
            "debugImageContext": {
                "shouldAttachImage": should_attach_image,
                "hasImageP1": bool(image_base64_p1),
                "hasImageP2": bool(image_base64_p2),
                "agentEngine": agent_engine,
                "eventType": event_type,
                "agentImagePolicy": agent_image_policy,
                "isReset": is_reset,
                "requestedTtsMode": requested_tts_mode,
            }
        }
        if audio_payload:
            response_body.update(audio_payload)
        if is_reset:
            response_body["welcomeMessage"] = commentary_text

        return {
            "statusCode": 200,
            "headers": headers,
            "body": json.dumps(response_body)
        }

    # Endpoint: /api/trigger-technique
    elif path == "/api/trigger-technique" and method == "POST":
        technique = body.get("technique", "")
        robot_id = body.get("robotId", "robot_1")
        role = body.get("role", "none")
        
        # 1. Resolve target robots
        targets = []
        if robot_id == "all":
            if role == "player1":
                targets = ["robot_1", "robot_2", "robot_3"]
            elif role == "player2":
                targets = ["robot_4", "robot_5", "robot_6"]
            else:
                targets = ["robot_1"]
        else:
            targets = [robot_id]

        # 2. Match technique against JJK_ACTION_MAP
        map_info = JJK_ACTION_MAP.get(technique)
        stance = map_info["stance"] if map_info else technique
        speech = map_info["speech"] if map_info else None
        language = map_info.get("language", "ja") if map_info else "ja"

        # 3. Trigger physical action and AWS Polly voice concurrently for all targets
        triggered_targets = []

        # Map JJK technique directly to the exact existing MCP tool API
        technique_to_mcp_tool = {
            "domain_unlimited_void": "robot_kung_fu",
            "domain_malevolent_shrine": "robot_right_uppercut",
            "domain_self_embodiment": "robot_twist",
            "domain_authentic_love": "robot_wave",
            "domain_idle_death_gamble": "robot_left_uppercut",
            "domain_yuji_itadori": "robot_sit_ups",
            "domain_chimera_shadow_garden": "robot_squat",
            "domain_time_cell_moon_palace": "robot_twist",
            "lapse_blue": "robot_left_shot_fast",
            "reversal_red": "robot_right_shot_fast",
            "hollow_purple": "robot_left_kick"
        }

        for target in targets:
            # Resolve the specific existing MCP tool name directly from the technique
            mcp_tool_name = technique_to_mcp_tool.get(technique, f"robot_{technique}")

            # B. Trigger Speak/Polly synthesizer via AgentCore Gateway
            if speech:
                invoke_agentcore_gateway_tool(
                    tool_name="robot-only-mcp-lambda___robot_speak",
                    arguments={
                        "robot_id": target,
                        "text": speech,
                        "language": language
                    }
                )

            # A. Trigger Robot Action via AgentCore Gateway
            if mcp_tool_name:
                invoke_agentcore_gateway_tool(
                    tool_name=f"robot-only-mcp-lambda___{mcp_tool_name}",
                    arguments={
                        "robot_id": target
                    }
                )
                triggered_targets.append(target)

        return {
            "statusCode": 200,
            "headers": headers,
            "body": json.dumps({
                "success": len(triggered_targets) > 0,
                "targets": targets,
                "triggered_targets": triggered_targets,
                "action": stance,
                "speech_triggered": bool(speech)
            })
        }

    return {"statusCode": 404, "headers": headers, "body": json.dumps({"error": "Route not found"})}
