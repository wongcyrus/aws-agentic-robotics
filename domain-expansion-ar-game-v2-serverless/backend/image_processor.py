import os
import json
import logging
import boto3
import base64
import io
import time
import random
from PIL import Image

logger = logging.getLogger()

# Resolve Environment Variables
SESSIONS_TABLE = os.environ.get("SESSIONS_TABLE")
BEDROCK_REGION = os.environ.get("BEDROCK_REGION", "us-east-1")
PHOTOS_S3_BUCKET = os.environ.get("PHOTOS_S3_BUCKET")
IMAGE_GEN_MODEL_ID = os.environ.get("IMAGE_GEN_MODEL_ID", "amazon.nova-canvas-v1:0")

# Initialize DynamoDB Table reference
db = boto3.resource("dynamodb")
sessions_table = db.Table(SESSIONS_TABLE) if SESSIONS_TABLE else None

def update_enhancement_state(session_id, state_value):
    if not sessions_table:
        return
    sessions_table.update_item(
        Key={"session_id": session_id},
        UpdateExpression="SET enhanced_image_url = :value, updated_at = :t",
        ExpressionAttributeValues={
            ":value": state_value,
            ":t": int(time.time())
        }
    )

TEMPLATE_REGISTRY = {
    "infinite_clash": {
        "name": "Infinite Clash (Gojo vs Sukuna)",
        "path": "templates/infinite_clash.jpg",
        "prompt": "A high-fidelity JJK anime keyframe of Gojo Satoru and Ryomen Sukuna locked in the ultimate Domain Expansion clash. Gojo Satoru on the right side preparing the Unlimited Void hand sign; Ryomen Sukuna on the left side preparing the Malevolent Shrine hand sign.",
        "coords": {
            "p1": {"center": (540, 390), "size": 140},
            "p2": {"center": (1530, 480), "size": 140}
        }
    },
    "sendai_clash": {
        "name": "Sendai Colony Clash (Three-Way)",
        "path": "templates/sendai_clash.jpg",
        "prompt": "A spectacular neon JJK anime illustration of a three-way Domain Expansion clash. Yuta Okkotsu in the center releasing purple energy with his ring, and Takako Uro on the right side screaming intensely with pink energy hair.",
        "coords": {
            "p1": {"center": (1040, 260), "size": 180},
            "p2": {"center": (1700, 440), "size": 180}
        }
    }
}

def get_cropped_face(image_bytes):
    """Detects first face using Amazon Rekognition, applies 25% padding margin, crops and returns PIL Image."""
    try:
        rek = boto3.client("rekognition")
        response = rek.detect_faces(Image={"Bytes": image_bytes}, Attributes=["DEFAULT"])
        face_details = response.get("FaceDetails", [])
        if not face_details:
            logger.info("Rekognition: No faces detected in image.")
            return None
        
        # Crop the first face
        box = face_details[0]["BoundingBox"]
        img = Image.open(io.BytesIO(image_bytes))
        w, h = img.size
        
        # Grab face bounding box coordinates
        left = int(box["Left"] * w)
        top = int(box["Top"] * h)
        width = int(box["Width"] * w)
        height = int(box["Height"] * h)
        
        # Apply 25% boundary expansion (padding) to capture the full face cleanly (hair, jawline)
        margin_x = int(width * 0.25)
        margin_y = int(height * 0.25)
        
        x1 = max(0, left - margin_x)
        y1 = max(0, top - margin_y)
        x2 = min(w, left + width + margin_x)
        y2 = min(h, top + height + margin_y)
        
        logger.info(f"Rekognition Face Cropped: ({x1}, {y1}) to ({x2}, {y2})")
        return img.crop((x1, y1, x2, y2))
    except Exception as e:
        logger.error(f"Rekognition Face Crop Error: {e}")
        return None

def handle_sqs_image_gen(record):
    """SQS Record trigger that generates AI Domain portraits using Pillow and Bedrock Nova Canvas."""
    logger.info(f"Asynchronous Image Generation Worker triggered by SQS record: {record.get('messageId')}")
    
    if not sessions_table:
        logger.error("DynamoDB sessions_table is not initialized!")
        return

    try:
        body = json.loads(record.get("body", "{}"))
    except Exception as e:
        logger.error(f"Failed to parse SQS message body: {e}")
        return

    session_id = body.get("session_id", "mcpserver")
    template_id = body.get("template_id", "random")
    
    # 1. Resolve random selection if requested
    if template_id == "random" or template_id not in TEMPLATE_REGISTRY:
        template_id = random.choice(list(TEMPLATE_REGISTRY.keys()))
        logger.info(f"Template resolved from 'random' to '{template_id}'")
        
    template = TEMPLATE_REGISTRY[template_id]
    
    # 2. Retrieve session state from DynamoDB
    try:
        resp = sessions_table.get_item(Key={"session_id": session_id})
        item = resp.get("Item")
    except Exception as e:
        logger.error(f"Failed to retrieve session {session_id} from DynamoDB: {e}")
        return

    if not item:
        logger.error(f"Session {session_id} record not found in DynamoDB.")
        return

    # Helper to clean data-url header if present
    def decode_b64_to_bytes(b64_str):
        if "," in b64_str:
            b64_str = b64_str.split(",", 1)[1]
        return base64.b64decode(b64_str)

    s3_client = boto3.client("s3") if PHOTOS_S3_BUCKET else None

    def load_snapshot_bytes(role_key, legacy_field_name):
        if s3_client and PHOTOS_S3_BUCKET:
            s3_key = f"webcam_snapshots/{session_id}/{role_key}.jpg"
            try:
                obj = s3_client.get_object(Bucket=PHOTOS_S3_BUCKET, Key=s3_key)
                image_bytes = obj["Body"].read()
                logger.info(f"Loaded {role_key} snapshot for portrait generation from S3 ({len(image_bytes)} bytes)")
                return image_bytes, "s3"
            except Exception as e:
                logger.warning(f"Could not load {role_key} snapshot from S3 for portrait generation: {e}")

        legacy_b64 = item.get(legacy_field_name, "")
        if legacy_b64:
            image_bytes = decode_b64_to_bytes(legacy_b64)
            logger.info(f"Loaded {role_key} snapshot for portrait generation from legacy DynamoDB field")
            return image_bytes, "dynamodb"

        return None, "missing"

    p1_bytes, p1_source = load_snapshot_bytes("player1", "latest_webcam_frame_p1")
    p2_bytes, p2_source = load_snapshot_bytes("player2", "latest_webcam_frame_p2")

    if not p1_bytes or not p2_bytes:
        logger.error(
            f"Webcam snapshots missing for session {session_id}. "
            f"P1 source: {p1_source}, P2 source: {p2_source}"
        )
        update_enhancement_state(session_id, "ERROR: SNAPSHOTS_MISSING")
        return

    # 3. Detect and crop faces from P1 and P2
    p1_face = get_cropped_face(p1_bytes)
    p2_face = get_cropped_face(p2_bytes)

    # If Rekognition failed to locate a face on either snapshot, write specialized error state and exit
    if not p1_face or not p2_face:
        logger.error(f"Face detection failed on one or both snapshots. P1 face: {bool(p1_face)}, P2 face: {bool(p2_face)}")
        update_enhancement_state(session_id, "ERROR: NO_FACE")
        return

    # 4. Pillow pre-compositing: Load backend template and paste faces onto specified coordinates
    try:
        # Load local template image relative to lambda directory
        template_file_path = template["path"]
        if not os.path.exists(template_file_path):
            # Try loading relative to module
            base_dir = os.path.dirname(os.path.abspath(__file__))
            template_file_path = os.path.join(base_dir, template["path"])
            
        logger.info(f"Loading template from local disk: {template_file_path}")
        template_img = Image.open(template_file_path).convert("RGB")
        
        # Extract configuration coordinates
        p1_cfg = template["coords"]["p1"]
        p2_cfg = template["coords"]["p2"]
        
        # Resize cropped face images to designated size
        p1_size = (p1_cfg["size"], p1_cfg["size"])
        p2_size = (p2_cfg["size"], p2_cfg["size"])
        
        p1_face_resized = p1_face.resize(p1_size, Image.Resampling.LANCZOS)
        p2_face_resized = p2_face.resize(p2_size, Image.Resampling.LANCZOS)
        
        # Calculate paste coordinates from centers
        p1_paste_x = p1_cfg["center"][0] - (p1_cfg["size"] // 2)
        p1_paste_y = p1_cfg["center"][1] - (p1_cfg["size"] // 2)
        
        p2_paste_x = p2_cfg["center"][0] - (p2_cfg["size"] // 2)
        p2_paste_y = p2_cfg["center"][1] - (p2_cfg["size"] // 2)
        
        # Paste face overlays onto template
        template_img.paste(p1_face_resized, (p1_paste_x, p1_paste_y))
        template_img.paste(p2_face_resized, (p2_paste_x, p2_paste_y))
        
        # Downscale the final composite image to maximum 1024x1024 to respect Bedrock Nova Canvas constraints
        max_size = 1024
        if template_img.width > max_size or template_img.height > max_size:
            template_img.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
            logger.info(f"Resized composite down to {template_img.size} to satisfy Bedrock limits.")
            
        composite_io = io.BytesIO()
        template_img.save(composite_io, format="JPEG", quality=90)
        composite_bytes = composite_io.getvalue()
        logger.info("Successfully stitched face snapshots onto template")
    except Exception as e:
        logger.error(f"Pillow pre-compositing failed: {e}")
        update_enhancement_state(session_id, "ERROR: COMPOSITE_FAILED")
        return

    # 5. Invoke AI Stylized Image Generation Engine
    generated_bytes = None
    try:
        bedrock = boto3.client("bedrock-runtime", region_name=BEDROCK_REGION)
        
        # Standard quality, cost-efficient settings for Bedrock Nova Canvas
        body_payload = {
            "taskType": "IMAGE_TO_IMAGE",
            "imageToImageParams": {
                "images": [base64.b64encode(composite_bytes).decode("utf-8")],
                "text": template["prompt"],
                "similarityStrength": 0.55
            },
            "imageGenerationConfig": {
                "numberOfImages": 1,
                "quality": "standard",
                "height": template_img.height,
                "width": template_img.width,
                "cfgScale": 7.0
            }
        }
        
        logger.info(f"Invoking Bedrock Nova Canvas for style fusion. Model ID: {IMAGE_GEN_MODEL_ID}")
        response = bedrock.invoke_model(
            modelId=IMAGE_GEN_MODEL_ID,
            contentType="application/json",
            accept="application/json",
            body=json.dumps(body_payload)
        )
        
        response_body = json.loads(response.get("body").read().decode("utf-8"))
        images = response_body.get("images", [])
        if not images:
            raise ValueError("Bedrock Nova Canvas response returned no images.")
            
        generated_bytes = base64.b64decode(images[0])
        logger.info("Successfully received style fusion image from Bedrock Nova Canvas.")
    except Exception as e:
        logger.error(f"Bedrock Nova Canvas style fusion failed: {e}")
        error_text = str(e)
        if "AccessDeniedException" in error_text or "not authorized to perform: bedrock:InvokeModel" in error_text:
            update_enhancement_state(session_id, "ERROR: BEDROCK_ACCESS_DENIED")
        elif "Legacy" in error_text and "not been actively using the model in the last 30 days" in error_text:
            update_enhancement_state(session_id, "ERROR: BEDROCK_LEGACY_MODEL")
        elif "ResourceNotFoundException" in error_text and "Access denied" in error_text:
            update_enhancement_state(session_id, "ERROR: BEDROCK_MODEL_UNAVAILABLE")
        else:
            update_enhancement_state(session_id, "ERROR: BEDROCK_FAILED")
        return

    # 6. Save final output image to S3 bucket
    photos_bucket = PHOTOS_S3_BUCKET
    if not photos_bucket:
        logger.error("PHOTOS_S3_BUCKET env variable is missing!")
        return

    s3_key = f"enhanced_portraits/{session_id}/scroll.jpg"
    try:
        s3_client = boto3.client("s3")
        s3_client.put_object(
            Bucket=photos_bucket,
            Key=s3_key,
            Body=generated_bytes,
            ContentType="image/jpeg"
        )
        # Construct public URL (S3 bucket allows public reads via lifecycle policy)
        photos_domain = os.environ.get('PHOTOS_S3_DOMAIN', f"{photos_bucket}.s3.amazonaws.com")
        public_url = f"https://{photos_domain}/{s3_key}"
        logger.info(f"Uploaded enhanced portrait to S3: {public_url}")
        
        # 7. Update session enhanced_image_url with public URL in DynamoDB
        sessions_table.update_item(
            Key={"session_id": session_id},
            UpdateExpression="SET enhanced_image_url = :url, updated_at = :t",
            ExpressionAttributeValues={
                ":url": public_url,
                ":t": int(time.time())
            }
        )
        logger.info(f"Updated DynamoDB session record with public URL: {public_url}")
    except Exception as e:
        logger.error(f"Failed to upload output portrait or update session record: {e}")
        update_enhancement_state(session_id, "ERROR: UPLOAD_FAILED")
