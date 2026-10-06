"""FastAPI Server and Strands BidiAgent for Robot Voice Control."""

import os
import logging
import asyncio
import contextvars
import json
from pathlib import Path
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
import uvicorn
import boto3

# Strands BidiAgent & Model
from strands.bidi import BidiAgent
from strands.bidi.models import BedrockNovaSonicModel

from bidi_bridge import BidiBrowserBridge, convert_client_event
from tools import cleanup_tools, get_all_tools, warmup_tools

# Configure Logger
logging.basicConfig(
    level=logging.WARNING,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("robot_voice_agent")

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

# Context variable for current WebSocket's selected robots list
selected_robots_var = contextvars.ContextVar("selected_robots", default=["all"])

# Environment variables
COGNITO_REGION = os.environ.get("CognitoRegion", "us-east-1")
AWS_BEDROCK_REGION = os.environ.get("AWS_BEDROCK_REGION", "us-east-1")
NOVA_SONIC_MODEL_ID = os.environ.get(
    "NOVA_SONIC_MODEL_ID", "amazon.nova-2-5-sonic"
)


def load_system_prompt() -> str:
    """Load specialized robotic command prompt from file."""
    prompt_path = Path(__file__).parent / "prompts" / "robot_command_prompt.txt"
    if prompt_path.exists():
        with open(prompt_path, "r", encoding="utf-8") as f:
            return f.read()
    
    # Fallback default prompt
    return """You are a robot command assistant.
Your primary role is to execute physical actions by calling the available tools.
Interpret natural spoken forms like "robot 1" as structured IDs like `robot_1`.
Map natural action phrases like "stand up", "go forward", and "wave" to the closest matching tool.
Keep spoken replies concise and action-oriented."""


def generate_dynamic_prompt(robots: list) -> str:
    """Dynamically adjust prompt based on selected hardware devices."""
    base_prompt = load_system_prompt()
    
    supported_devices = [
        device
        for device in robots
        if device.startswith("robot_") or device.startswith("xiaoice_")
    ]
    has_all = "all" in robots or len(supported_devices) >= 7 or not supported_devices

    robots_list = [device for device in supported_devices if device.startswith("robot_")]
    xiaoice_list = [
        device for device in supported_devices if device.startswith("xiaoice_")
    ]
    
    focus_areas = []
    if robots_list:
        focus_areas.append(f"Robots ({', '.join(robots_list)})")
    if xiaoice_list:
        focus_areas.append(f"Digital Human ({', '.join(xiaoice_list)})")
        
    focus_summary = " and ".join(focus_areas) if focus_areas else "no active hardware"
    
    dynamic_instruction = "\n\n=== DYNAMIC HARDWARE SELECTION CONTEXT ===\n"
    if has_all:
        dynamic_instruction += (
            "You are currently commanding the entire integrated fleet synchronously: all Robots and Xiaoice.\n"
            "You have full access to all command tools. You can coordinate multiple devices together or refer to the collective fleet.\n"
            'Interpret collective phrases like "all robots", "everyone", and "all of them" as commands for the relevant full active group.'
        )
    else:
        dynamic_instruction += (
            f"IMPORTANT: The user has selected a restricted subset of active devices. You are currently commanding ONLY: {', '.join(supported_devices)}.\n"
            f"Active Focus Area(s): {focus_summary}.\n"
            "Your tool executions and spoken replies must be strictly limited to these selected systems.\n"
            'When the user says "all robots", "everyone", or "all of them", interpret that as the full currently selected subset for the relevant category.\n'
            "For example:\n"
        )
        if robots_list and not xiaoice_list:
            dynamic_instruction += "- Since ONLY humanoid/wheeled robots are active, focus 100% on robot actions (stand, move, walk, check sensors) and discuss only robot telemetry.\n"
        elif xiaoice_list and not robots_list:
            dynamic_instruction += "- Since ONLY the digital human is active, focus on supported speech and presentation interactions.\n"
        else:
            dynamic_instruction += "- Coordinate and execute tools strictly targeting the specific devices that are checked above.\n"
            
    dynamic_instruction += "\n=========================================="
    return base_prompt + dynamic_instruction


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Manage application startup and shutdown hooks."""
    logger.info("🤖 Robot Voice Control AgentCore Service starting up...")
    logger.info(
        "MCP runtime configuration: gateway_url=%s tool_prefix_allow=%s tool_exclude=%s",
        os.environ.get("McpServerGatewayUrl", ""),
        os.environ.get("MCP_TOOL_PREFIX_ALLOW", ""),
        os.environ.get("MCP_TOOL_EXCLUDE", ""),
    )
    try:
        warmed_tools = warmup_tools()
        logger.info(f"MCP tools warmed at startup: {len(warmed_tools)} loaded")
    except Exception as e:
        logger.warning(f"MCP tool warmup failed at startup; will retry on demand: {e}")
    # Add the endpoint filter after Uvicorn startup to prevent logger override
    logging.getLogger("uvicorn.access").addFilter(EndpointFilter())
    yield
    cleanup_tools()
    logger.info("🤖 Robot Voice Control AgentCore Service shutting down...")


app = FastAPI(
    title="Robot Voice Control AgentCore Service",
    description="Python Strands-Agents Microservice for Bidirectional Robotics Command Streaming",
    version="2.0.0",
    lifespan=lifespan,
)


@app.get("/ping")
async def health_check():
    """Health check endpoint required by AWS AgentCore & AppRunner."""
    return JSONResponse(
        content={"status": "healthy", "service": "robot-voice-agentcore"},
        status_code=200,
    )


@app.get("/api/auth/config")
async def get_auth_config():
    """Retrieve Cognito authentication configuration parameters."""
    return JSONResponse(
        content={
            "userPoolId": os.environ.get("CognitoUserPoolId"),
            "clientId": os.environ.get("CognitoUserPoolClientId"),
            "region": COGNITO_REGION,
        }
    )


@app.post("/api/auth/login")
async def login(payload: dict):
    """Authenticate username and password credentials against Cognito."""
    username = payload.get("username")
    password = payload.get("password")

    if not username or not password:
        return JSONResponse(
            status_code=400,
            content={"message": "Username and password are required."},
        )

    try:
        client = boto3.client("cognito-idp", region_name=COGNITO_REGION)
        response = client.initiate_auth(
            ClientId=os.environ.get("CognitoUserPoolClientId"),
            AuthFlow="USER_PASSWORD_AUTH",
            AuthParameters={
                "USERNAME": username,
                "PASSWORD": password,
            },
        )
        auth_result = response.get("AuthenticationResult")
        if auth_result:
            return JSONResponse(
                content={
                    "accessToken": auth_result.get("AccessToken"),
                    "idToken": auth_result.get("IdToken"),
                    "refreshToken": auth_result.get("RefreshToken"),
                }
            )
        return JSONResponse(
            status_code=401,
            content={"message": "Authentication failed."},
        )
    except Exception as e:
        logger.error(f"Cognito Authentication Error: {e}")
        return JSONResponse(status_code=401, content={"message": str(e)})


@app.get("/login.html")
async def serve_login():
    """Serve the login HTML asset."""
    return FileResponse(Path(__file__).parent.parent / "frontend" / "login.html")


@app.get("/favicon.ico")
async def serve_favicon():
    """Serve the website favicon."""
    return FileResponse(Path(__file__).parent.parent / "frontend" / "favicon.ico")


@app.get("/")
async def serve_index():
    """Serve the core interactive voice control dashboard HTML page."""
    return FileResponse(Path(__file__).parent.parent / "frontend" / "index.html")


@app.get("/background_hk.jpg")
async def serve_background():
    """Serve the theatrical RPG background image."""
    return FileResponse(Path(__file__).parent.parent / "frontend" / "background_hk.jpg")


# Mount the JavaScript/CSS sources directory statically at /src
app.mount("/src", StaticFiles(directory=Path(__file__).parent.parent / "frontend" / "src"), name="src")


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket endpoint for bidirectional audio streaming.

    Authenticates connections via Cognito AccessToken query parameters,
    initializes the Strands BidiAgent with Bedrock Nova Sonic model,
    and runs the live real-time dialogue loop.
    """
    logger.info("Incoming WebSocket connection request...")

    # Accept the connection (Authentication is managed serverlessly by AWS IAM/SigV4 at the Bedrock AgentCore boundary)
    await websocket.accept()
    logger.info("WebSocket connection established via Bedrock AgentCore IAM.")

    # Parse voice selection
    voice_id = websocket.query_params.get("voice_id", "tiffany")

    # 1. Initialize immediately from query parameters so AgentCore doesn't sit idle
    # waiting for the first frontend message after the socket has already opened.
    robots_param = websocket.query_params.get("robots", "all")
    robots = [item.strip() for item in robots_param.split(",") if item.strip()]
    if not robots:
        robots = ["all"]
    logger.info(f"Handshake - Initial selected robots from query params: {robots}")

    # Set active session state
    selected_robots_var.set(robots)

    try:
        # 2. Compile dynamic system prompt and load tools
        system_prompt = generate_dynamic_prompt(robots)
        tools = get_all_tools()
        logger.info(f"Loaded {len(tools)} tools. Initial system prompt compiled for: {robots}")

        # 3. Instantiate model targeting official AWS Model ID
        model = BedrockNovaSonicModel(
            region=AWS_BEDROCK_REGION,
            model_id=NOVA_SONIC_MODEL_ID,
            voice=voice_id,
            audio={
                "input": {"sample_rate": 16000},
                "output": {"sample_rate": 16000},
            },
        )

        # 4. Initialize the BidiAgent with the CORRECT, dynamically adjusted, purged system prompt from second zero!
        agent = BidiAgent(
            model=model,
            tools=tools,
            system_prompt=system_prompt,
        )
        logger.info("Strands BidiAgent instantiated successfully. Launching streaming event loop...")
        browser_bridge = BidiBrowserBridge()

        # Converter function to map incoming websocket JSON payloads into Strands Events
        async def receive_and_convert():
            while True:
                try:
                    data = await websocket.receive_json()
                except WebSocketDisconnect:
                    logger.info("WebSocket client disconnected abruptly.")
                    raise
                except Exception as ex:
                    logger.error(f"Error receiving websocket JSON: {ex}")
                    raise

                event_type = data.get("type")
                if not event_type:
                    continue

                logger.info(f"Inbound client event: {event_type}")

                # Update selected robot state (mid-session)
                if event_type == "robot":
                    robots_val = data.get("robots", ["all"])
                    if not isinstance(robots_val, list):
                        robots_val = [robots_val]
                    selected_robots_var.set(robots_val)
                    logger.info(f"Selected robots updated mid-session to: {robots_val}")
                    
                    # Dynamically adjust the system prompt on the active BidiAgent instance
                    try:
                        dynamic_prompt = generate_dynamic_prompt(robots_val)
                        agent.system_prompt = dynamic_prompt
                        logger.info(f"System prompt dynamically updated mid-session for {len(robots_val)} devices: {robots_val}")
                    except Exception as e:
                        logger.error(f"Failed to dynamically update agent system prompt mid-session: {e}")
                        
                    # Notify client back
                    await websocket.send_json({"type": "robot_received", "robots": robots_val})
                    continue

                # Strip 'type' and convert to native Strands input events
                event_data = {k: v for k, v in data.items() if k != "type"}

                if event_type in [
                    "bidi_audio_input",
                    "bidi_text_input",
                    "bidi_image_input",
                ]:
                    return convert_client_event(event_type, event_data)
                elif event_type in ["audioStart", "promptStart", "systemPrompt"]:
                    # Handle state signals
                    logger.info(f"Signal received: {event_type}")
                    # We map them to an empty/prompt event if needed, or bypass
                    continue
                elif event_type == "stopAudio":
                    logger.info("Client requested audio stream termination.")
                    # Stop microphone capture without injecting an invalid event into BidiAgent.
                    continue

        # Output adapter to serialize Strands Agent events into Bedrock WebSocket payloads
        async def output_adapter(event):
            event_type = type(event).__name__
            logger.info(f"Outbound agent event: {event_type}")
            if "Tool" in event_type or "tool" in event_type:
                logger.info(
                    "Tool-related outbound event payload: %s",
                    getattr(event, "__dict__", str(event)),
                )

            handled, payload = browser_bridge.translate_output_event(event)
            if handled:
                if payload is not None:
                    await websocket.send_json(payload)
                return

            try:
                if hasattr(event, "to_dict"):
                    await websocket.send_json(event.to_dict())
                elif hasattr(event, "__dict__"):
                    await websocket.send_json(event.__dict__)
                else:
                    await websocket.send_json(event)
            except Exception as ex:
                logger.error(f"Failed to serialize outbound event {event_type}: {ex}")

        # Execute BidiAgent with input stream wrapper and output target
        await agent.run(
            inputs=[receive_and_convert],
            outputs=[output_adapter],
        )
        logger.info("BidiAgent session run complete.")

    except WebSocketDisconnect:
        logger.info("WebSocket disconnect handled.")
    except Exception as e:
        logger.exception("Error during active WebSocket session execution")
        try:
            await websocket.send_json({"type": "error", "message": str(e)})
            await websocket.close(code=1011, reason=str(e)[:120])
        except Exception:
            pass
    finally:
        logger.info("WebSocket session lifecycle finished.")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    host = os.environ.get("HOST", "0.0.0.0")
    logger.info(f"Starting FastAPI Robot Voice Control Service on {host}:{port}")
    uvicorn.run(
        app,
        host=host,
        port=port,
        log_level="info",
        access_log=True,
    )
