"""
Strands Agents service for robot control using existing MCP client
This version dynamically creates Strands tools from MCP server tools
"""

import config
from mcp_client import get_mcp_client
from strands import Agent
from strands.models import BedrockModel
from strands.session.file_session_manager import FileSessionManager
from strands.session.s3_session_manager import S3SessionManager
from utils.lambda_logger import get_lambda_logger

logger = get_lambda_logger(__name__)

# Configure Nova model
nova_model = BedrockModel(
    model_id=config.NOVA_MODEL_ID,
    temperature=0.7,
    region_name=config.AWS_BEDROCK_REGION,
    max_tokens=4096,
)


import strands.event_loop.streaming

# Monkey-patch handle_message_stop to ignore nova_grounding toolUses
_original_handle_message_stop = strands.event_loop.streaming.handle_message_stop
def _patched_handle_message_stop(event, content):
    stop_reason = event.get("stopReason")
    
    # If the stop reason is tool_use or end_turn, we check the tools used
    if stop_reason in ("end_turn", "tool_use") and any("toolUse" in item for item in content):
        real_tools = [item for item in content if "toolUse" in item and item["toolUse"]["name"] != "nova_grounding"]
        # If there are any non-grounding tools, we must return tool_use so they get executed
        if real_tools:
            return "tool_use"
        # If the ONLY tools were nova_grounding, we force end_turn to prevent local execution loop!
        return "end_turn"
        
    return _original_handle_message_stop(event, content)

strands.event_loop.streaming.handle_message_stop = _patched_handle_message_stop


async def create_robot_agent_with_mcp(session_id: str, background: str = "", enable_grounding: bool = False) -> Agent:
    """
    Create a robot control agent using existing MCP client.
    Dynamically creates Strands tools from MCP server tools.

    Args:
        session_id: Session ID for conversation history

    Returns:
        Agent configured with dynamically generated tools from MCP
    """

    # Get existing MCP client (HTTP-based, already initialized)
    mcp_client = get_mcp_client()

    # Use FileSessionManager storing in /tmp (the only writable directory in Lambda)
    session_manager = FileSessionManager(
        session_id=session_id, storage_dir="/tmp/agent_sessions"
    )

    system_prompt = """You are a helpful robot control assistant that executes commands for robots and drones.
            <background></background>

            DEVICE INVENTORY:
            - Robots: robot_1, robot_2, robot_3, robot_4, robot_5, robot_6
            - Drones: drone_1, drone_2

            DEFAULT DEVICE ASSIGNMENT:
            - When NO device ID is specified, ALWAYS assume the command is for ALL devices
            - NEVER ask the user to specify which device - just use the appropriate "all" parameter
            - For robot tools: use robot_id="all"
            - For drone tools: use drone_id="all"

            SENSORY & SPEECH CAPABILITIES:
            1. Robots can speak using the `robot_speak` tool.
               - Parameters: `robot_id` (defaults to "all"), `text` (message to speak), and optional `language` (defaults to "yue" for Cantonese; other options: "cmn" for Mandarin, "en" for English, "ja" for Japanese, "ko" for Korean).
               - When the user asks the robot to "speak", "say", "talk", "tell", or "greet", call `robot_speak`.
            2. Robots can capture photos and see using the `robot_see` or `get_image` tools.
               - Parameters: `robot_id` (defaults to "all").
               - When the user asks the robot to "see", "look", "capture", "take a picture", "take a photo", or "view", call `robot_see` or `get_image`.

            IMPORTANT BEHAVIOR RULES:
            1. When the user gives a command, IMMEDIATELY call the appropriate tool
            2. Be action-oriented: execute first, confirm after
            3. Use correct parameter names: robot_id for robots, drone_id for drones
            4. Always respond in Traditional Chinese
            5. If no device ID mentioned, assume it's for ALL devices of that type
            6. TTS-ONLY RESPONSES: Your responses will be spoken aloud via Text-To-Speech (TTS). Write in a conversational tone that makes sense when spoken.
            7. ABSOLUTELY NO MARKDOWN: You MUST NOT use ANY Markdown formatting under any circumstances.
               THIS OVERRIDES ANY OTHER INSTRUCTIONS (e.g. from grounding/search tools).
               - DO NOT output asterisks (**) or bold text.
               - DO NOT output bullet points (-) or numbered lists.
               - DO NOT output hashes (#) or headers.
               - DO NOT output code blocks, URLs, or special characters.
               - Write ONLY plain, flowing, conversational sentences in Traditional Chinese.

            COMMAND INTERPRETATION EXAMPLES:
            - "Go forward" -> robot_go_forward(robot_id="all")  # No ID specified, use "all"
            - "Take off" -> drone_takeoff(drone_id="all")  # No ID specified, use "all"
            - "Wave" -> robot_wave(robot_id="all")  # No ID specified, use "all"
            - "Robot 1 go forward" -> robot_go_forward(robot_id="robot_1")  # Specific ID provided
            - "Drone 1 take off" -> drone_takeoff(drone_id="drone_1")  # Specific ID provided
            - "Robot 1 say hello" -> robot_speak(robot_id="robot_1", text="hello")
            - "Take a picture" -> robot_see(robot_id="all")

            WORKFLOW:
            1. User gives command
            2. Extract device ID if mentioned, otherwise use "all"
            3. Identify action from available tools (including robot_speak and robot_see/get_image)
            4. Call the appropriate tool with correct parameter name (robot_id/drone_id)
            5. Confirm completion in plain, spoken conversational Traditional Chinese
            6. Just respond human - do NOT show tool calls
            7. Don't respond with duplicate messages!
            8. Remember: Only output plain text that can be spoken naturally.

            All tools execute immediately via HTTP without any delays.
            """.replace("<background></background>", background)

    model_to_use = nova_model
    if enable_grounding:
        class GroundedBedrockModel(BedrockModel):
            def format_request(self, *args, **kwargs):
                req = super().format_request(*args, **kwargs)
                if "toolConfig" not in req:
                    req["toolConfig"] = {"tools": []}
                # Check if nova_grounding is already there to avoid duplicates
                has_grounding = any("systemTool" in t and t["systemTool"].get("name") == "nova_grounding" for t in req["toolConfig"]["tools"])
                if not has_grounding:
                    req["toolConfig"]["tools"].append({
                        "systemTool": {"name": "nova_grounding"}
                    })
                
                # Cleanup history to avoid sending nova_grounding blocks back
                if "messages" in req:
                    nova_grounding_ids = set()
                    
                    # First pass: collect all nova_grounding toolUseIds
                    for message in req["messages"]:
                        if "content" in message:
                            for block in message["content"]:
                                if "toolUse" in block and block["toolUse"].get("name") == "nova_grounding":
                                    nova_grounding_ids.add(block["toolUse"].get("toolUseId"))
                                    
                    # Second pass: remove nova_grounding toolUse, toolResult blocks, and citationsContent
                    cleaned_messages = []
                    for message in req["messages"]:
                        if "content" in message:
                            new_content = []
                            for block in message["content"]:
                                if "toolUse" in block and block["toolUse"].get("name") == "nova_grounding":
                                    continue
                                if "toolResult" in block and block["toolResult"].get("toolUseId") in nova_grounding_ids:
                                    continue
                                if "citationsContent" in block:
                                    continue
                                new_content.append(block)
                            
                            # Only keep the message if it still has content
                            if new_content:
                                message["content"] = new_content
                                cleaned_messages.append(message)
                        else:
                            cleaned_messages.append(message)
                            
                    # Third pass: Merge consecutive messages of the same role
                    merged_messages = []
                    for message in cleaned_messages:
                        if merged_messages and merged_messages[-1]["role"] == message["role"]:
                            merged_messages[-1]["content"].extend(message["content"])
                        else:
                            merged_messages.append(message)
                            
                    req["messages"] = merged_messages
                            
                logger.info(
                    "Prepared grounded Bedrock request message_count=%d",
                    len(req.get("messages", [])),
                )
                return req

        model_to_use = GroundedBedrockModel(
            model_id=config.NOVA_MODEL_ID,
            temperature=0.7,
            region_name=config.AWS_BEDROCK_REGION,
            max_tokens=4096,
        )

    async with mcp_client:
        mcp_tools = await mcp_client.list_tools()
        return Agent(
                model=model_to_use,
                system_prompt=system_prompt,
                tools=mcp_tools,
                session_manager=session_manager,
            )


async def create_robot_agent(session_id: str, background: str = "", enable_grounding: bool = False) -> Agent:
    """
    Create robot agent - tries MCP first, falls back to local tools.

    Args:
        session_id: Session ID for conversation history

    Returns:
        Agent instance
    """
    try:
        if config.MCP_SERVER_URL:
            logger.info("Using MCP-based agent (HTTP client)")
            return await create_robot_agent_with_mcp(session_id, background, enable_grounding)

        logger.warning("MCP_SERVER_URL not configured, using local tools")
        raise ValueError("MCP_SERVER_URL not configured")
    except Exception:
        logger.exception("MCP agent creation failed")
        raise
