import os
import json
import logging
import time
import base64
import io
import boto3
from decimal import Decimal
from PIL import Image

from http_request import (
    JSON_HEADERS,
    LiveStatusRequest,
    build_commentary_prompt,
    build_technique_plan,
    normalize_session_id,
    parse_json_body,
    snapshot_role_key,
    summarize_event,
)
from observability import Metric, MetricsEmitter
from websocket_handler import handle_websocket_event


metrics = MetricsEmitter()


def invoke_agentcore_gateway_tool(
    tool_name: str,
    arguments: dict,
    *,
    gateway_url: str | None = None,
    session_factory=None,
    http_post=None,
    metrics_emitter: MetricsEmitter = metrics,
):
    """Invoke a tool exposed by the Bedrock AgentCore Gateway using AWS SigV4."""
    gateway_url = (
        os.environ.get("McpServerGatewayUrl", "").strip()
        if gateway_url is None
        else gateway_url.strip()
    )
    if not gateway_url:
        return

    try:
        import requests
        from botocore.auth import SigV4Auth
        from botocore.awsrequest import AWSRequest
        from botocore.session import Session

        session = (session_factory or Session)()
        resolved_credentials = session.get_credentials()
        if resolved_credentials is None:
            raise RuntimeError("AWS credentials are required for AgentCore gateway calls")
        credentials = resolved_credentials.get_frozen_credentials()
        region = session.get_config_variable("region") or os.environ.get(
            "AWS_REGION", "us-east-1"
        )

        payload = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": tool_name, "arguments": arguments},
            }
        ).encode("utf-8")

        post_request = AWSRequest(method="POST", url=gateway_url, data=payload)
        SigV4Auth(credentials, "bedrock-agentcore", region).add_auth(post_request)

        headers = dict(post_request.headers)
        headers["Content-Type"] = "application/json"
        headers["Accept"] = "application/json"

        post_response = (http_post or requests.post)(
            gateway_url, data=payload, headers=headers, timeout=15
        )
        if post_response.status_code != 200:
            raise RuntimeError(
                f"AgentCore gateway returned HTTP {post_response.status_code}"
            )
        logger.info("AgentCore gateway invocation successful for tool: %s", tool_name)
        return post_response.text
    except Exception:
        metrics_emitter.emit(Metric("AgentCoreGatewayFailure"), tool=tool_name)
        logger.exception("Failed to invoke AgentCore gateway tool %s", tool_name)
        raise

# Configure Logger
logger = logging.getLogger()
logger.setLevel(getattr(logging, os.environ.get("LOG_LEVEL", "INFO").upper(), logging.INFO))

connections_table_name = os.environ.get("CONNECTIONS_TABLE", "DomainExpansionConnections")
sessions_table_name = os.environ.get("SESSIONS_TABLE", "DomainExpansionSessions")

connections_table = None
sessions_table = None


def get_connections_table():
    global connections_table
    if connections_table is None:
        connections_table = boto3.resource("dynamodb").Table(connections_table_name)
    return connections_table


def get_sessions_table():
    global sessions_table
    if sessions_table is None:
        sessions_table = boto3.resource("dynamodb").Table(sessions_table_name)
    return sessions_table

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
    metrics_emitter: MetricsEmitter = metrics,
):
    logger.info("Incoming event: %s", summarize_event(event))
    if not isinstance(event, dict):
        return {
            "statusCode": 400,
            "headers": JSON_HEADERS,
            "body": json.dumps({"error": "Event must be a JSON object"}),
        }
    
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
                except Exception:
                    metrics_emitter.emit(Metric("SqsImageGenerationFailure"))
                    logger.exception("SQS generation failed")
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
    domain = r_ctx.get("domainName")
    stage = r_ctx.get("stage")
    ws_endpoint = f"https://{domain}/{stage}"
    return handle_websocket_event(
        event,
        r_ctx,
        connections_table=get_connections_table(),
        api_client=boto3.client("apigatewaymanagementapi", endpoint_url=ws_endpoint),
        logger=logger,
        metrics=metrics,
    )


# HTTP REST API Handler
def handle_http(event):
    path = event.get("path", "")
    method = event.get("httpMethod", "GET")
    logger.info(f"REST Route: {method} {path}")

    # Standard JSON CORS Headers
    headers = JSON_HEADERS

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

    body = parse_json_body(event)

    # Endpoint: /api/enhance-portrait (POST)
    if path == "/api/enhance-portrait" and method == "POST":
        session_id = normalize_session_id(body.get("sessionId", "mcpserver"))
            
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
            get_sessions_table().update_item(
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
        session_id = normalize_session_id(q_params.get("sessionId", "mcpserver"))
            
        logger.info(f"Check enhancement status for session={session_id}")

        try:
            resp = get_sessions_table().get_item(Key={"session_id": session_id})
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

            role_key = snapshot_role_key(role)
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

        get_sessions_table().put_item(
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

            role_key = snapshot_role_key(role)
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
            get_sessions_table().update_item(
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

            role_key = snapshot_role_key(role)
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
        
        live_request = LiveStatusRequest.from_body(body, path, DEFAULT_AGENT_TYPE)
        session_id = live_request.session_id
        event_type = live_request.event_type
        agent_image_policy = live_request.agent_image_policy
        requested_tts_mode = live_request.requested_tts_mode
        commentary_language = live_request.commentary_language
        is_reset = live_request.is_reset

        logger.info(
            "Live-status session=%s eventType=%s reset=%s policy=%s foul=%s",
            session_id,
            event_type,
            is_reset,
            agent_image_policy,
            live_request.foul_language,
        )

        # Execute localized JJK translation
        translated_event = translate_detail(live_request.text_event)
        content_block = build_commentary_prompt(live_request, translated_event)

        # Try to retrieve the latest webcam frames for multimodal analysis
        image_bytes_p1 = None
        image_bytes_p2 = None
        image_format_p1 = "jpeg"
        image_format_p2 = "jpeg"
        image_base64_p1 = ""
        image_base64_p2 = ""
        
        # Decide if we should attach image based on policy
        should_attach_image = live_request.should_attach_image

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
        agent_engine = live_request.agent_engine
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
        plan = build_technique_plan(body)

        # 3. Trigger physical action and AWS Polly voice concurrently for all targets
        triggered_targets = []

        for target in plan.targets:
            # B. Trigger Speak/Polly synthesizer via AgentCore Gateway
            if plan.speech:
                invoke_agentcore_gateway_tool(
                    tool_name="robot-only-mcp-lambda___robot_speak",
                    arguments={
                        "robot_id": target,
                        "text": plan.speech,
                        "language": plan.language
                    }
                )

            # A. Trigger Robot Action via AgentCore Gateway
            if plan.mcp_tool_name:
                invoke_agentcore_gateway_tool(
                    tool_name=f"robot-only-mcp-lambda___{plan.mcp_tool_name}",
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
                "targets": plan.targets,
                "triggered_targets": triggered_targets,
                "action": plan.stance,
                "speech_triggered": bool(plan.speech)
            })
        }

    return {"statusCode": 404, "headers": headers, "body": json.dumps({"error": "Route not found"})}
