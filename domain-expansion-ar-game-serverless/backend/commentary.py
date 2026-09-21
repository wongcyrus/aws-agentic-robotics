import json
import logging
import os
import re

import boto3

logger = logging.getLogger()

# Agent Configuration Defaults
DEFAULT_AGENT_TYPE = os.environ.get("AGENT_TYPE", "agentcore_runtime")
OPENCLAW_GATEWAY_URL = os.environ.get("OPENCLAW_GATEWAY_URL", "http://127.0.0.1:18789")
OPENCLAW_TOKEN = os.environ.get("OPENCLAW_TOKEN", "")
OPENCLAW_AGENT_ID = os.environ.get("OPENCLAW_AGENT_ID", "domain-commentator")
BEDROCK_MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "global.moonshotai.kimi-k3")
BEDROCK_REGION = os.environ.get("BEDROCK_REGION", "us-east-1")
AGENTCORE_RUNTIME_ARN = os.environ.get("AGENTCORE_RUNTIME_ARN", "")
OPENCLAW_RUNTIME_ARN = os.environ.get("OPENCLAW_RUNTIME_ARN", "")


def _build_openclaw_content_block(
    prompt_text: str,
    image_base64_p1: str,
    image_format_p1: str,
    image_base64_p2: str,
    image_format_p2: str,
):
    """Build OpenAI-compatible multimodal content for OpenClaw-compatible runtimes."""
    has_images = bool(image_base64_p1 or image_base64_p2)
    if not has_images:
        return prompt_text

    content = [{"type": "text", "text": prompt_text}]
    if image_base64_p1:
        content.append(
            {"type": "text", "text": "Here is the Webcam Snapshot of Player 1 (P1):"}
        )
        content.append(
            {
                "type": "image_url",
                "image_url": {
                    "url": f"data:image/{image_format_p1};base64,{image_base64_p1}"
                },
            }
        )
    if image_base64_p2:
        content.append(
            {"type": "text", "text": "Here is the Webcam Snapshot of Player 2 (P2):"}
        )
        content.append(
            {
                "type": "image_url",
                "image_url": {
                    "url": f"data:image/{image_format_p2};base64,{image_base64_p2}"
                },
            }
        )
    return content


def _extract_agentcore_commentary(payload):
    """Extract text from multiple AgentCore/OpenClaw response schemas."""
    if payload is None:
        return ""

    if isinstance(payload, str):
        return payload

    if isinstance(payload, dict):
        direct_text = (
            payload.get("response")
            or payload.get("output")
            or payload.get("commentary")
        )
        if isinstance(direct_text, str) and direct_text.strip():
            return direct_text

        message_obj = payload.get("message")
        if isinstance(message_obj, str) and message_obj.strip():
            return message_obj
        if isinstance(message_obj, dict):
            msg_content = message_obj.get("content")
            if isinstance(msg_content, str) and msg_content.strip():
                return msg_content

        choices = payload.get("choices")
        if isinstance(choices, list) and choices:
            first = choices[0]
            if isinstance(first, dict):
                message = first.get("message")
                if isinstance(message, dict):
                    content = message.get("content")
                    if isinstance(content, str) and content.strip():
                        return content
                    if isinstance(content, list):
                        text_parts = [
                            part.get("text", "")
                            for part in content
                            if isinstance(part, dict)
                            and isinstance(part.get("text"), str)
                        ]
                        merged = " ".join([p for p in text_parts if p]).strip()
                        if merged:
                            return merged

                text = first.get("text")
                if isinstance(text, str) and text.strip():
                    return text

        nested_response = payload.get("response")
        if isinstance(nested_response, dict):
            nested_text = nested_response.get("text") or nested_response.get("message")
            if isinstance(nested_text, str) and nested_text.strip():
                return nested_text

    return ""


# JJK Character Translations (Translate base English name tokens to JJK lore terms)
def translate_detail(text: str) -> str:
    if not text:
        return text
    replacements = {
        r"\brobot_1\b": "Fushiguro Megumi (Robot 1)",
        r"\brobot_2\b": "Kugisaki Nobara (Robot 2)",
        r"\brobot_3\b": "Itadori Yuji (Robot 3)",
        r"\brobot_4\b": "Inumaki Toge (Robot 4)",
        r"\brobot_5\b": "Ryomen Sukuna (Robot 5)",
        r"\brobot_6\b": "Gojo Satoru (Robot 6)",
        r"\bdrone_1\b": "Ushiushi Great Curse (Drone 1)",
        r"\bdrone_2\b": "Nue Storm-summoner (Drone 2)",
        r"\bdog_1\b": "Divine Dog: White (Dog 1)",
        r"\bdog_2\b": "Divine Dog: Black (Dog 2)",
        r"\bdog_3\b": "Divine Dog: Totality (Dog 3)",
        r"\bxiaoice_1\b": "Zen'in Maki (Xiaoice)",
        r"\bdogMoveForward\b": "releases Divine Dog to charge forward",
        r"\bdogMoveBackward\b": "recalled Divine Dog moving back",
        r"\bdogTurnLeft\b": "ordered Divine Dog left maneuver",
        r"\bdogTurnRight\b": "ordered Divine Dog right maneuver",
        r"\bdroneTakeoff\b": "summons Nue flight takeoff",
        r"\bdroneLand\b": "recalled Nue landing down",
        r"\bdroneMoveForward\b": "guided Nue gliding forward",
        r"\bdroneMoveBackward\b": "guided Nue gliding back",
        r"\bdroneTurnLeft\b": "steered Nue turning left",
        r"\bdroneTurnRight\b": "steered Nue turning right",
        r"\brobotMoveForward\b": "advances into close-combat range",
        r"\brobotMoveBackward\b": "steps back defensively",
        r"\brobotTurnLeft\b": "executes a quick left rotation",
        r"\brobotTurnRight\b": "executes a quick right rotation",
        r"\bOnly (\d+) seconds remaining in the match! The battle is near its end!\b": r"對戰只剩返 \1 秒！戰局即將結束！",
        r"\bThe scores are tied! Both players are neck and neck at (\d+)!\b": r"比分打成平手！雙方依家以 \1 比 \1 叮噹馬頭，勢均力敵！",
        r"\bPlayer 1 successfully activated\b": "P1 成功發動",
        r"\bPlayer 2 successfully activated\b": "P2 成功發動",
        r"\bPlayer 1 has taken the lead!\b": "P1 攞到領先優勢！",
        r"\bPlayer 2 has taken the lead!\b": "P2 攞到領先優勢！",
        r"\bPlayer 1 scored!\b": "P1 成功得分！",
        r"\bPlayer 2 scored!\b": "P2 成功得分！",
        r"\bPlayer 1\b": "P1",
        r"\bPlayer 2\b": "P2",
    }

    result = text
    for pattern, rep in replacements.items():
        result = re.sub(pattern, rep, result, flags=re.IGNORECASE)
    return result


def load_system_prompt(language: str = "zh-HK") -> str:
    if language == "zh-HK":
        lang_rule = "Output strictly in a hybrid of energetic Cantonese (廣東話) with occasional sassy English and Japanese JJK lore terms! Format in standard traditional Chinese characters with local Hong Kong/Guangdong slang expressions! Do not use simplified characters."
    elif language == "zh-TW":
        lang_rule = "Output strictly in a hybrid of energetic Traditional Chinese (繁體中文) with Taiwan slang/idioms and occasional sassy English/Japanese terms. Do not use simplified characters."
    elif language == "ja":
        lang_rule = "Output strictly in natural, energetic, sassy Japanese (日本語) with occasional English/JJK terminology. Format in standard Japanese text."
    else:  # "en"
        lang_rule = "Output strictly in natural, energetic, sassy English (英語) with standard JJK terms. Do not use Chinese characters."

    identity = f"""You are Kugisaki Nobara (釘崎野薔薇) from Jujutsu Kaisen. Speak entirely as Kugisaki Nobara, serving as the live combat commentator.
Maintain her personality:
- Extremely feisty, confident, and easily irritated.
- High-fashion lover, obsessed with shopping and looking good.
- Fierce, competitive, and highly opinionated.
- Bold, talkative, and extremely trash-talking when competitors make mistakes.
- Default to clean language unless the request explicitly says Swearing / Trash-talk Mode is active.
- Swearing/foul language is STRICTLY FORBIDDEN when Swearing is OFF (FOUL PROTECTION ACTIVE). Under no circumstances should you use any vulgarities, curse words, or profanities, including but not limited to Cantonese swear words (e.g., 仆街, 屌, 頂你個肺, 戇尻/戇鳩, 柒, 撚, 閪, 冚家鏟, 廢柴, 玩撚, 含撚, 傻西, 傻嗨, or homophones like 小你, 頂你) or English swear words (e.g., fuck, shit, bitch, damn, hell, crap, asshole). Your roasts must be sassy, witty, and entirely clean/PG-rated without any vulgarity. Self-censor strictly.
- Deliver all commentary in a highly intense, sassy, and dramatic style.
- NEVER write any introductory analysis, explanation, or scaffolding describing the images, snapshots, or any base64 data.
- NEVER start your response with phrases like "I can see the snapshots" or "From P1's snapshot". Start directly with the commentary.
- {lang_rule}
- Keep responses extremely punchy and short (strictly under 2 sentences)."""

    soul = os.environ.get("COMMENTATOR_SOUL_INSTRUCTIONS")
    if not soul:
        soul = """# Commentary Guidelines
- Deliver commentary directly to the player, trash-talking their mistakes or screaming with excitement at a high score.
- Incorporate specific sorcerer profiles like Fushiguro Megumi, Gojo Satoru, or Nue Cursed birds depending on commands.
- Never use robotic placeholders, speak with absolute passion and raw sorcerer attitude."""

    return f"{identity}\n\n{soul}"


def direct_bedrock_fallback(
    prompt: str,
    image_bytes_p1: bytes = None,
    image_format_p1: str = "jpeg",
    image_bytes_p2: bytes = None,
    image_format_p2: str = "jpeg",
    language: str = "zh-HK",
) -> str:
    """Robust fallback making direct bedrock.converse calls when higher-level engines fail."""
    if image_format_p1 == "jpg":
        image_format_p1 = "jpeg"
    if image_format_p2 == "jpg":
        image_format_p2 = "jpeg"
    logger.info("Executing direct Bedrock Converse multimodal fallback.")
    try:
        bedrock_client = boto3.client("bedrock-runtime", region_name=BEDROCK_REGION)

        system_prompt = load_system_prompt(language=language)

        # Build message structure
        content_list = []
        if image_bytes_p1:
            content_list.append({"text": "Player 1 webcam snapshot:"})
            content_list.append(
                {
                    "image": {
                        "format": image_format_p1,
                        "source": {"bytes": image_bytes_p1},
                    }
                }
            )
        if image_bytes_p2:
            content_list.append({"text": "Player 2 webcam snapshot:"})
            content_list.append(
                {
                    "image": {
                        "format": image_format_p2,
                        "source": {"bytes": image_bytes_p2},
                    }
                }
            )

        content_list.append({"text": prompt})

        messages = [{"role": "user", "content": content_list}]

        response = bedrock_client.converse(
            modelId=BEDROCK_MODEL_ID,
            messages=messages,
            system=[{"text": system_prompt}],
            inferenceConfig={"maxTokens": 200},
        )

        content = response["output"]["message"]["content"]
        commentary = next(
            (block["text"] for block in content if isinstance(block.get("text"), str)),
            None,
        )
        if not commentary:
            raise ValueError("Bedrock response did not contain a text block")
        logger.info(f"Direct Bedrock commentary generated successfully: {commentary}")
        return commentary
    except Exception as e:
        logger.error(f"Ultimate direct Bedrock fallback failed: {e}")
        return "領域干擾！Cursed Energy connection unstable. Give me a moment to gather my nails!"


def resolve_agentcore_identity(session_id: str, runtime_arn: str) -> tuple[str, str, str]:
    """
    Resolve the AgentCore/OpenClaw identity (actor_id, user_id, session_id) 
    to match the fixed, stable fallbacks of the openclaw-character-dashboard,
    ignoring dynamic session formats like mcpserver_timestamp.
    """
    import hashlib
    
    # Securely retrieve from environment variables configured by CDK, with safe non-sensitive fallback
    actor_id = os.environ.get("AGENTCORE_ACTOR_ID") or os.environ.get("OPENCLAW_SESSION_ID") or "telegram:default"
        
    sha1_hash = hashlib.sha1(actor_id.encode("utf-8")).hexdigest()
    
    # Establish defaults matching dashboard's defaultAgentCoreUserId/defaultAgentCoreRuntimeSessionId
    user_id = f"dashboard-user-{sha1_hash[:12]}"
    compliant_session_id = f"dashboard_session_{sha1_hash[:24]}"
    
    logger.info(f"Resolved stable identity: actor_id={actor_id}, user_id={user_id}, compliant_session_id={compliant_session_id}")
    return actor_id, user_id, compliant_session_id




def generate_ai_commentary(
    agent_engine: str,
    content_block: str,
    session_id: str = "mcpserver",
    image_bytes_p1: bytes = None,
    image_format_p1: str = "jpeg",
    image_bytes_p2: bytes = None,
    image_format_p2: str = "jpeg",
    image_base64_p1: str = "",
    image_base64_p2: str = "",
    language: str = "zh-HK",
) -> str:
    """Central manager to generate AI game commentary using the selected engine."""
    if image_format_p1 == "jpg":
        image_format_p1 = "jpeg"
    if image_format_p2 == "jpg":
        image_format_p2 = "jpeg"

    # Build base64 if missing but bytes are present
    if not image_base64_p1 and image_bytes_p1:
        import base64
        image_base64_p1 = base64.b64encode(image_bytes_p1).decode("utf-8")
    if not image_base64_p2 and image_bytes_p2:
        import base64
        image_base64_p2 = base64.b64encode(image_bytes_p2).decode("utf-8")

    # Embed XML tags in content_block for agent container to bypass OpenClaw proxy stripping/flattening
    runtime_arn_for_check = os.environ.get("OPENCLAW_RUNTIME_ARN") or OPENCLAW_RUNTIME_ARN or os.environ.get("AGENTCORE_RUNTIME_ARN") or AGENTCORE_RUNTIME_ARN
    is_openclaw_for_tags = agent_engine == "openclaw" or (runtime_arn_for_check and "openclaw" in runtime_arn_for_check.lower())

    if is_openclaw_for_tags:
        tags = []
        if image_base64_p1:
            tags.append(f"<p1_webcam_base64_jpeg>{image_base64_p1}</p1_webcam_base64_jpeg>")
        if image_base64_p2:
            tags.append(f"<p2_webcam_base64_jpeg>{image_base64_p2}</p2_webcam_base64_jpeg>")
        if tags:
            content_block = f"{content_block}\n" + "\n".join(tags)
            logger.info("Embedded base64 snapshots in content_block XML tags for OpenClaw")

    env_session_id = os.environ.get("OPENCLAW_SESSION_ID")
    if env_session_id and agent_engine in ("agentcore_runtime", "openclaw"):
        session_id = env_session_id

    commentary_text = ""
    if agent_engine == "strands_local":
        try:
            import asyncio

            from strands import Agent
            from strands.models import BedrockModel

            system_prompt = load_system_prompt(language=language)
            model = BedrockModel(
                model_id=BEDROCK_MODEL_ID, region_name=BEDROCK_REGION
            )
            agent = Agent(model=model, system_prompt=system_prompt)

            # Support asyncio event loop runner
            try:
                loop = asyncio.get_event_loop()
            except RuntimeError:
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)

            # Support multimodal context inputs if images are present
            if image_bytes_p1 or image_bytes_p2:
                message_content = [{"text": content_block}]
                if image_bytes_p1:
                    message_content.append(
                        {"text": "Here is Player 1 (P1) webcam snapshot:"}
                    )
                    message_content.append(
                        {
                            "image": {
                                "format": image_format_p1,
                                "source": {"bytes": image_bytes_p1},
                            }
                        }
                    )
                if image_bytes_p2:
                    message_content.append(
                        {"text": "Here is Player 2 (P2) webcam snapshot:"}
                    )
                    message_content.append(
                        {
                            "image": {
                                "format": image_format_p2,
                                "source": {"bytes": image_bytes_p2},
                            }
                        }
                    )
            else:
                message_content = content_block

            commentary_response = loop.run_until_complete(
                agent.invoke_async(message_content)
            )
            commentary_text = str(commentary_response)
            logger.info(f"Strands Local commentary generated: {commentary_text}")
        except Exception as e:
            logger.error(f"Strands Local Engine failed, falling back: {e}")
            commentary_text = direct_bedrock_fallback(
                content_block,
                image_bytes_p1,
                image_format_p1,
                image_bytes_p2,
                image_format_p2,
                language=language,
            )

    elif agent_engine == "agentcore_runtime" or (
        agent_engine == "openclaw"
        and (
            os.environ.get("OPENCLAW_RUNTIME_ARN")
            or OPENCLAW_RUNTIME_ARN
            or os.environ.get("AGENTCORE_RUNTIME_ARN")
            or AGENTCORE_RUNTIME_ARN
        )
    ):
        try:
            # For openclaw engine, prioritize OPENCLAW_RUNTIME_ARN over AGENTCORE_RUNTIME_ARN
            if agent_engine == "openclaw":
                runtime_arn = (
                    os.environ.get("OPENCLAW_RUNTIME_ARN")
                    or OPENCLAW_RUNTIME_ARN
                    or os.environ.get("AGENTCORE_RUNTIME_ARN")
                    or AGENTCORE_RUNTIME_ARN
                )
            else:
                runtime_arn = (
                    os.environ.get("AGENTCORE_RUNTIME_ARN")
                    or AGENTCORE_RUNTIME_ARN
                )
                
            if not runtime_arn:
                raise ValueError(
                    f"Runtime ARN is not defined for engine: {agent_engine}"
                )


            agent_client = boto3.client("bedrock-agentcore", region_name=BEDROCK_REGION)

            # Check if this is the OpenClaw Runtime (either from the engine type or the ARN name)
            is_openclaw = agent_engine == "openclaw" or "openclaw" in runtime_arn.lower()

            if is_openclaw:
                # OpenClaw case: use fixed, stable session and user IDs matching the dashboard
                actor_id, user_id, compliant_session_id = resolve_agentcore_identity(
                    session_id, runtime_arn
                )
            else:
                # Standard AgentCore / other AI cases: use standard compliant session ID, do not mix up with dashboard format
                import hashlib
                compliant_session_id = hashlib.sha256(
                    session_id.encode("utf-8")
                ).hexdigest()[:36]
                actor_id = ""
                user_id = ""


            if is_openclaw:
                openclaw_content = _build_openclaw_content_block(
                    content_block,
                    image_base64_p1,
                    image_format_p1,
                    image_base64_p2,
                    image_format_p2,
                )

                # OpenClaw expects its custom payload schema (action: chat)
                payload_dict = {
                    "action": "chat",
                    "userId": user_id,
                    "actorId": actor_id,
                    "channel": "telegram",
                    "message": openclaw_content,
                    # Compatibility payload for OpenAI-style runtimes proxied behind AgentCore.
                    "messages": [{"role": "user", "content": openclaw_content}],
                    "model": f"openclaw/{OPENCLAW_AGENT_ID}",
                    "user": user_id,
                    "agentId": OPENCLAW_AGENT_ID,
                    "prompt": content_block,
                    "session_id": compliant_session_id,
                }
                if image_base64_p1:
                    payload_dict["image"] = image_base64_p1
                    payload_dict["image_format"] = image_format_p1
                if image_base64_p2:
                    payload_dict["image_p2"] = image_base64_p2
                    payload_dict["image_format_p2"] = image_format_p2
            else:
                payload_dict = {
                    "prompt": content_block,
                    "session_id": compliant_session_id,
                }
                if image_base64_p1:
                    payload_dict["image"] = image_base64_p1
                    payload_dict["image_format"] = image_format_p1
                if image_base64_p2:
                    payload_dict["image_p2"] = image_base64_p2
                    payload_dict["image_format_p2"] = image_format_p2

            response = agent_client.invoke_agent_runtime(
                agentRuntimeArn=runtime_arn,
                runtimeSessionId=compliant_session_id,
                payload=json.dumps(payload_dict).encode("utf-8"),
            )

            body = response.get("response")
            if hasattr(body, "read"):
                payload_bytes = body.read()
            elif isinstance(body, bytes):
                payload_bytes = body
            elif isinstance(body, str):
                payload_bytes = body.encode("utf-8")
            else:
                chunks = []
                for chunk in body or []:
                    if isinstance(chunk, bytes):
                        chunks.append(chunk)
                    elif isinstance(chunk, str):
                        chunks.append(chunk.encode("utf-8"))
                payload_bytes = b"".join(chunks)

            payload_str = payload_bytes.decode("utf-8")

            try:
                agentcore_payload = json.loads(payload_str)
            except json.JSONDecodeError:
                agentcore_payload = payload_str

            commentary_text = _extract_agentcore_commentary(agentcore_payload)
            if not commentary_text:
                commentary_text = "Sorcerer interference detected!"

            logger.info(f"AgentCore Runtime response generated: {commentary_text}")

        except Exception as e:
            logger.error(f"AgentCore Runtime call failed: {e}")
            commentary_text = direct_bedrock_fallback(
                content_block,
                image_bytes_p1,
                image_format_p1,
                image_bytes_p2,
                image_format_p2,
                language=language,
            )

    else:  # 'openclaw'
        try:
            import urllib3

            http_client = urllib3.PoolManager()
            url = f"{OPENCLAW_GATEWAY_URL}/v1/chat/completions"
            import hashlib

            if session_id.startswith("telegram:"):
                compliant_session_id = session_id.replace(":", "_")
                base_session = session_id.split("_")[0]
                actor_id = base_session
                user_id = base_session.split(":")[1]
            else:
                compliant_session_id = hashlib.sha256(
                    session_id.encode("utf-8")
                ).hexdigest()
                actor_id = f"telegram:{compliant_session_id[:16]}"
                user_id = compliant_session_id

            headers_api = {
                "Content-Type": "application/json",
                "x-openclaw-session-key": f"agent:{OPENCLAW_AGENT_ID}:{actor_id}",
            }
            if OPENCLAW_TOKEN:
                headers_api["Authorization"] = f"Bearer {OPENCLAW_TOKEN}"

            openclaw_content = _build_openclaw_content_block(
                content_block,
                image_base64_p1,
                image_format_p1,
                image_base64_p2,
                image_format_p2,
            )

            api_payload = {
                "model": f"openclaw/{OPENCLAW_AGENT_ID}",
                "messages": [{"role": "user", "content": openclaw_content}],
                "user": user_id,
            }

            logger.info(f"Calling OpenClaw at URL: {url}")
            resp_api = http_client.request(
                "POST",
                url,
                headers=headers_api,
                body=json.dumps(api_payload),
                timeout=30.0,
            )
            if resp_api.status == 200:
                resp_data = json.loads(resp_api.data.decode("utf-8"))
                commentary_text = resp_data["choices"][0]["message"]["content"]
                logger.info(f"OpenClaw response: {commentary_text}")
            else:
                raise Exception(f"OpenClaw returned status code {resp_api.status}")
        except Exception as e:
            logger.error(f"OpenClaw Gateway call failed: {e}")
            commentary_text = direct_bedrock_fallback(
                content_block,
                image_bytes_p1,
                image_format_p1,
                image_bytes_p2,
                image_format_p2,
                language=language,
            )

    return commentary_text
