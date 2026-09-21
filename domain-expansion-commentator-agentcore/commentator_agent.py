import os
import logging
from pathlib import Path
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
import uvicorn
import boto3

# Configure Logger
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("jjk_commentator_agentcore")

# Filter out continuous AWS AgentCore health check logs (GET /ping) to keep agent logs clean
class EndpointFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        # Check if this log record contains arguments representing the HTTP request
        if record.args and len(record.args) >= 3:
            path = record.args[2]
            # Drop the log if the path is a health check endpoint
            if path == "/ping" or path == "/":
                return False
        return True

logging.getLogger("uvicorn.access").addFilter(EndpointFilter())

# Env Variables
BEDROCK_MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "global.moonshotai.kimi-k3")
AWS_BEDROCK_REGION = os.environ.get("AWS_BEDROCK_REGION", "us-east-1")

# Helper to load system prompts
def load_system_prompt() -> str:
    identity_path = Path(__file__).parent / "prompts" / "IDENTITY.md"
    soul_path = Path(__file__).parent / "prompts" / "SOUL.md"
    
    identity = ""
    soul = ""
    
    if identity_path.exists():
        with open(identity_path, "r", encoding="utf-8") as f:
            identity = f.read()
    else:
        identity = """# Character Identity: Kugisaki Nobara (钉崎野蔷薇)
- Role: High-energy JJK match commentator.
- Personality: Feisty, extremely confident, slightly arrogant, styling, fashion-loving, and deeply competitive.
- Language: High-octane, sassy, blending English & Chinese naturally. Use JJK terms (Domain Expansion, cursed techniques, Black Flash).
- Tone: Dynamic, energetic, hyping up technique executions! Keep each output to 2-3 short, punchy sentences max!"""

    if soul_path.exists():
        with open(soul_path, "r", encoding="utf-8") as f:
            soul = f.read()
    else:
        soul = """# Commentary Guidelines
- Deliver commentary directly to the player, trash-talking their mistakes or screaming with excitement at a high score.
- Incorporate specific sorcerer profiles like Fushiguro Megumi, Gojo Satoru, or Nue Cursed birds depending on commands.
- Never use robotic placeholders, speak with absolute passion and raw sorcerer attitude."""

    return f"{identity}\n\n{soul}"

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Initializing JJK Commentator AgentCore container lifespan...")
    # Add the endpoint filter after Uvicorn startup to prevent logger override
    logging.getLogger("uvicorn.access").addFilter(EndpointFilter())
    # Pre-compile system prompt to verify paths
    prompt = load_system_prompt()
    logger.info(f"Loaded JJK system prompt successfully (length: {len(prompt)})")
    yield
    logger.info("Shutting down JJK Commentator AgentCore container...")

app = FastAPI(
    title="JJK Commentator AgentCore Service",
    description="Python Strands-Agents Microservice for Serverless Domain Expansion Match Commentary",
    version="1.0.0",
    lifespan=lifespan,
)

@app.get("/ping")
async def health_check():
    """Health check endpoint required by AWS AgentCore runtime."""
    return JSONResponse(
        content={"status": "healthy", "service": "jjk-commentator-agentcore"},
        status_code=200,
    )

@app.post("/invocations")
@app.post("/invoke")
@app.post("/")
async def invoke_agent(request: Request):
    """Handles commentary requests from the AWS serverless Lambda gateway."""
    try:
        body = await request.json()
        prompt_text = body.get("prompt", "")
        session_id = body.get("session_id", "main")
        
        if not prompt_text:
            # Try to extract prompt from OpenClaw messages schema
            messages = body.get("messages")
            if isinstance(messages, list) and len(messages) > 0:
                first_msg = messages[0]
                if isinstance(first_msg, dict):
                    content = first_msg.get("content")
                    if isinstance(content, str):
                        prompt_text = content
                    elif isinstance(content, list):
                        text_parts = []
                        for part in content:
                            if isinstance(part, dict):
                                if part.get("type") == "text":
                                    text_parts.append(part.get("text", ""))
                        prompt_text = "\n".join([p for p in text_parts if p]).strip()
            
            if not prompt_text:
                message = body.get("message")
                if isinstance(message, str):
                    prompt_text = message
                elif isinstance(message, list):
                    text_parts = []
                    for part in message:
                        if isinstance(part, dict):
                            if part.get("type") == "text":
                                text_parts.append(part.get("text", ""))
                    prompt_text = "\n".join([p for p in text_parts if p]).strip()

        if not prompt_text:
            return JSONResponse(
                status_code=400,
                content={"error": "Prompt field is required."}
            )

        logger.info(f"Agent invoked with prompt length: {len(prompt_text)} for session: {session_id}")

        # Initialize Strands Agent
        from strands import Agent
        from strands.models import BedrockModel

        system_prompt = load_system_prompt()
        model = BedrockModel(
            model_id=BEDROCK_MODEL_ID,
            region_name=AWS_BEDROCK_REGION
        )
        agent = Agent(
            model=model,
            system_prompt=system_prompt
        )

        image_b64_p1 = body.get("image", "")
        image_format_p1 = body.get("image_format", "jpeg")
        image_b64_p2 = body.get("image_p2", "")
        image_format_p2 = body.get("image_format_p2", "jpeg")

        # Extract and strip base64 snapshots from XML tags if present in prompt_text (bypassing gateway stripping/flattening)
        import re
        p1_pattern = re.compile(r"<p1_webcam_base64_jpeg>(.*?)</p1_webcam_base64_jpeg>", re.DOTALL)
        p2_pattern = re.compile(r"<p2_webcam_base64_jpeg>(.*?)</p2_webcam_base64_jpeg>", re.DOTALL)
        
        p1_xml_extracted = False
        p1_match = p1_pattern.search(prompt_text)
        if p1_match:
            image_b64_p1 = p1_match.group(1).strip()
            image_format_p1 = "jpeg"
            prompt_text = p1_pattern.sub("", prompt_text).strip()
            p1_xml_extracted = True
            
        p2_xml_extracted = False
        p2_match = p2_pattern.search(prompt_text)
        if p2_match:
            image_b64_p2 = p2_match.group(1).strip()
            image_format_p2 = "jpeg"
            prompt_text = p2_pattern.sub("", prompt_text).strip()
            p2_xml_extracted = True
            
        if p1_xml_extracted or p2_xml_extracted:
            logger.info(f"Successfully extracted snapshots from XML tags: p1={p1_xml_extracted}, p2={p2_xml_extracted}")

        # Extract images from OpenAI/OpenClaw-style messages/message if not present in root
        if not image_b64_p1 or not image_b64_p2:
            extracted_images = [] # list of (b64_str, format)
            
            def find_images_in_blocks(blocks):
                if not isinstance(blocks, list):
                    return
                for part in blocks:
                    if isinstance(part, dict) and part.get("type") == "image_url":
                        img_url_obj = part.get("image_url", {})
                        if isinstance(img_url_obj, dict):
                            url_str = img_url_obj.get("url", "")
                            if isinstance(url_str, str) and url_str.startswith("data:image/"):
                                try:
                                    header, b64_data = url_str.split(";base64,", 1)
                                    img_format = header.split("data:image/", 1)[1]
                                    extracted_images.append((b64_data, img_format))
                                except Exception:
                                    pass

            messages = body.get("messages")
            if isinstance(messages, list):
                for msg in messages:
                    if isinstance(msg, dict):
                        content = msg.get("content")
                        if isinstance(content, list):
                            find_images_in_blocks(content)
            
            message = body.get("message")
            if isinstance(message, list):
                find_images_in_blocks(message)

            if len(extracted_images) >= 1:
                if not image_b64_p1:
                    image_b64_p1, image_format_p1 = extracted_images[0]
            if len(extracted_images) >= 2:
                if not image_b64_p2:
                    image_b64_p2, image_format_p2 = extracted_images[1]

        if image_format_p1 == "jpg":
            image_format_p1 = "jpeg"
        if image_format_p2 == "jpg":
            image_format_p2 = "jpeg"

        multimodal_parts = []

        if image_b64_p1:
            import base64
            img_bytes_p1 = base64.b64decode(image_b64_p1)
            multimodal_parts.extend([
                {"text": "Player 1 (P1) pre-match webcam snapshot:"},
                {
                    "image": {
                        "format": image_format_p1,
                        "source": {"bytes": img_bytes_p1}
                    }
                }
            ])
            logger.info(f"Attached Player 1 image to multimodal invocation ({len(img_bytes_p1)} bytes)")

        if image_b64_p2:
            import base64
            img_bytes_p2 = base64.b64decode(image_b64_p2)
            multimodal_parts.extend([
                {"text": "Player 2 (P2) pre-match webcam snapshot:"},
                {
                    "image": {
                        "format": image_format_p2,
                        "source": {"bytes": img_bytes_p2}
                    }
                }
            ])
            logger.info(f"Attached Player 2 image to multimodal invocation ({len(img_bytes_p2)} bytes)")

        if multimodal_parts:
            message_content = multimodal_parts + [{"text": prompt_text}]
            logger.info(f"Executing multimodal agent invocation with {len(multimodal_parts)} non-text multimodal parts")
            response = await agent.invoke_async(message_content)
        else:
            response = await agent.invoke_async(prompt_text)

        response_text = str(response)

        logger.info(f"Commentary generated successfully: {response_text}")

        return JSONResponse(
            content={"response": response_text},
            status_code=200
        )
    except Exception as e:
        logger.error(f"Error executing Strands agent invocation: {e}", exc_info=True)
        return JSONResponse(
            status_code=500,
            content={"error": str(e)}
        )

if __name__ == "__main__":
    uvicorn.run("commentator_agent:app", host="0.0.0.0", port=8080, log_level="info")
