"""Pure HTTP request parsing and routing decisions for the Lambda gateway."""

import json
from dataclasses import dataclass
from typing import Any, TypedDict

JSON_HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST,GET,OPTIONS",
}


JJK_ACTION_MAP = {
    "domain_unlimited_void": {
        "stance": "kung_fu",
        "speech": "領域展開、無量空処",
        "language": "ja",
        "mcp_tool": "robot_kung_fu",
    },
    "domain_malevolent_shrine": {
        "stance": "right_uppercut",
        "speech": "領域展開、伏魔御厨子",
        "language": "ja",
        "mcp_tool": "robot_right_uppercut",
    },
    "domain_self_embodiment": {
        "stance": "twist",
        "speech": "領域展開、自閉円頓裹",
        "language": "ja",
        "mcp_tool": "robot_twist",
    },
    "domain_authentic_love": {
        "stance": "wave",
        "speech": "領域展開、真贋相愛",
        "language": "ja",
        "mcp_tool": "robot_wave",
    },
    "domain_idle_death_gamble": {
        "stance": "dance",
        "speech": "領域展開、坐殺博徒",
        "language": "ja",
        "mcp_tool": "robot_left_uppercut",
    },
    "domain_yuji_itadori": {
        "stance": "punch",
        "speech": "領域展開",
        "language": "ja",
        "mcp_tool": "robot_sit_ups",
    },
    "domain_chimera_shadow_garden": {
        "stance": "squat",
        "speech": "領域展開、嵌合暗翳庭",
        "language": "ja",
        "mcp_tool": "robot_squat",
    },
    "domain_time_cell_moon_palace": {
        "stance": "twist",
        "speech": "領域展開、時胞月宮殿",
        "language": "ja",
        "mcp_tool": "robot_twist",
    },
    "lapse_blue": {
        "stance": "left_shot_fast",
        "speech": "術式順転、蒼",
        "language": "ja",
        "mcp_tool": "robot_left_shot_fast",
    },
    "reversal_red": {
        "stance": "right_shot_fast",
        "speech": "術式反転、赫",
        "language": "ja",
        "mcp_tool": "robot_right_shot_fast",
    },
    "hollow_purple": {
        "stance": "kick",
        "speech": "虚式、茈",
        "language": "ja",
        "mcp_tool": "robot_left_kick",
    },
}


class JsonResponse(TypedDict):
    statusCode: int
    headers: dict[str, str]
    body: str


def parse_json_body(event: dict[str, Any]) -> dict[str, Any]:
    """Parse an API Gateway object body, returning an empty object when invalid."""
    raw_body = event.get("body")
    if not raw_body:
        return {}
    try:
        parsed = json.loads(raw_body)
    except (json.JSONDecodeError, TypeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def summarize_event(event: Any) -> dict[str, Any]:
    """Return routing metadata that is safe to include in logs."""
    if not isinstance(event, dict):
        return {"kind": "unknown"}
    request_context = event.get("requestContext", {})
    if event.get("type") == "REQUEST":
        return {"kind": "authorizer", "methodArn": event.get("methodArn")}
    if "Records" in event:
        return {"kind": "records", "count": len(event.get("Records") or [])}
    if "connectionId" in request_context:
        return {
            "kind": "websocket",
            "connectionId": request_context.get("connectionId"),
            "routeKey": request_context.get("routeKey"),
        }
    return {
        "kind": "http",
        "method": event.get("httpMethod", "GET"),
        "path": event.get("path", ""),
        "requestId": request_context.get("requestId"),
    }


def normalize_session_id(value: Any, default: str = "mcpserver") -> str:
    if not isinstance(value, str) or not value.strip():
        return default
    return value.strip()


def snapshot_role_key(role: str) -> str:
    if role == "player1":
        return "player1"
    if role == "player2":
        return "player2"
    return "viewer"


@dataclass(frozen=True)
class LiveStatusRequest:
    session_id: str
    room_code: str
    p1_score: Any
    p2_score: Any
    text_event: str
    event_type: str
    agent_image_policy: str
    foul_language: bool
    requested_tts_mode: str
    commentary_language: str
    agent_engine: str
    is_reset: bool
    is_battle_result: bool

    @classmethod
    def from_body(
        cls, body: dict[str, Any], path: str, default_agent_type: str
    ) -> "LiveStatusRequest":
        requested_tts_mode = str(body.get("ttsMode", "browser")).strip().lower()
        if requested_tts_mode not in {"browser", "aws"}:
            requested_tts_mode = "browser"
        event_type = body.get("eventType", "")
        is_battle_result = path == "/api/battle-result"
        return cls(
            session_id=body.get("sessionId", "mcpserver"),
            room_code=body.get("roomCode", "BTL1"),
            p1_score=body.get("p1Score", 0),
            p2_score=body.get("p2Score", 0),
            text_event=body.get("text") or body.get("detail") or "",
            event_type=event_type,
            agent_image_policy=body.get("agentImagePolicy", "always"),
            foul_language=bool(body.get("foulLanguage", False)),
            requested_tts_mode=requested_tts_mode,
            commentary_language=body.get("lang", "en"),
            agent_engine=body.get("agent_type", default_agent_type),
            is_reset=bool(body.get("isReset", False)) or event_type == "RESET" or is_battle_result,
            is_battle_result=is_battle_result,
        )

    @property
    def should_attach_image(self) -> bool:
        if self.agent_image_policy == "always":
            return True
        if self.agent_image_policy == "start_end":
            return self.is_reset or self.is_battle_result
        return False


def build_commentary_prompt(request: LiveStatusRequest, translated_event: str) -> str:
    tone_directive = (
        "Swearing / trash-talk mode is ACTIVE. You may use sharp Cantonese vulgarities or hard roasts if it fits Nobara's voice."
        if request.foul_language
        else "Swearing / foul language is STRICTLY FORBIDDEN and OFF (FOUL PROTECTION IS ACTIVE). "
        "You must keep the commentary completely clean, family-friendly, and strictly PG-rated. "
        "You are absolutely prohibited from using any Cantonese vulgarities, swear words, profanities, or offensive slang "
        "including but not limited to: 仆街 (puk gaai), 屌 (diu), 頂你個肺 (ding nei go fai), 戇尻/戇鳩/戇c (on gau), 柒/𨳍 (cat), 撚/𨶙 (lan), 閪/閪人 (hai), 冚家鏟, 廢柴, or any euphemisms/homophones of these words (such as 玩撚, 含撚, 傻西, 傻嗨, 小你, 頂你). "
        "Do not use any English profanity or curse words (e.g., fuck, shit, bitch, damn, hell, crap, asshole). "
        "Your roasts must be creative, humorous, and sassy without resorting to any vulgarity or abusive insults. "
        "Perform a strict self-censorship check on your output to ensure 100% compliance."
    )

    if request.is_battle_result:
        content = f"""
[BATTLE CONCLUSION TRIGGERED]
Final Match Results:
- Player 1 Score: {request.p1_score} points
- Player 2 Score: {request.p2_score} points
Summary description of final action: {translated_event}
Tone rule: {tone_directive}

If player snapshots are attached, do NOT explain, analyze, or describe the images first. Do NOT output any introductory description of what you see in the images. Incorporate any visual details or roasts silently and naturally into your final commentary dialogue. Give a spectacular, sass-filled, high-octane commentary conclusion. Declare the victor or roast them both if it's a draw. Be Kugisaki Nobara, feisty and fashionable! Keep it to 2 sentences!
"""
    elif request.is_reset:
        content = f"""
[MATCH INITIAL GREETING]
Tone rule: {tone_directive}
Introduce yourself as the supreme JJK Commentator (Kugisaki Nobara). Give a high-energy, confident greeting to the competitors starting their duel in Room {request.room_code}. The match has NOT started yet, so make this a pre-battle hype introduction before the countdown begins. If player snapshots are attached, do NOT explain, analyze, or describe the images first. Do NOT output any scaffolding (such as 'I can see the snapshots' or 'From P1's image'). Naturally and silently incorporate one or two specific visible details about each player's expression, stance, outfit, or readiness directly into your roleplay introduction dialogue. Tell them to prepare their cursed energy. Sassy, feisty, stylish! Keep it to 2 short sentences!
"""
    else:
        content = f"""
[MID-MATCH EVENT ENCOUNTERED]
Current Scores:
- Player 1 Score: {request.p1_score}
- Player 2 Score: {request.p2_score}
Latest Match Action: {translated_event}
Tone rule: {tone_directive}

If player snapshots are attached, do NOT explain, analyze, or describe the images first. Do NOT output any introductory text or scaffolding about what you see in the images. React instantly to this specific action! Give sassy, feisty sorcerer trash-talk or hype up the battle with extreme energy. Speak directly to them like an arrogant fashion-lover. Keep it to 2 short, punchy sentences max!
"""

    language_directives = {
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
        ),
    }
    language_directive = language_directives.get(request.commentary_language)
    if not language_directive:
        if request.commentary_language.startswith("zh"):
            language_directive = language_directives["zh-HK"]
        elif request.commentary_language.startswith("ja"):
            language_directive = language_directives["ja"]
        else:
            language_directive = language_directives["en"]

    formatting_directive = (
        "CRITICAL FORMATTING CONSTRAINT: Output ONLY the direct match commentary dialogue "
        "as Kugisaki Nobara. Do NOT write any introductory analysis, do NOT explain what you "
        "see in the snapshots, do NOT think out loud, and do NOT output any conversational scaffolding "
        "(such as 'Now let me provide...' or 'From the images...'). Start directly with the commentary."
    )
    return content.strip() + f"\n\n{language_directive}\n\n{formatting_directive}"


@dataclass(frozen=True)
class TechniquePlan:
    targets: list[str]
    stance: str
    speech: str | None
    language: str
    mcp_tool_name: str


def build_technique_plan(body: dict[str, Any]) -> TechniquePlan:
    technique = body.get("technique", "")
    robot_id = body.get("robotId", "robot_1")
    role = body.get("role", "none")

    if robot_id == "all":
        if role == "player1":
            targets = ["robot_1", "robot_2", "robot_3"]
        elif role == "player2":
            targets = ["robot_4", "robot_5", "robot_6"]
        else:
            targets = ["robot_1"]
    else:
        targets = [robot_id]

    mapping = JJK_ACTION_MAP.get(technique)
    return TechniquePlan(
        targets=targets,
        stance=mapping["stance"] if mapping else technique,
        speech=mapping["speech"] if mapping else None,
        language=mapping.get("language", "ja") if mapping else "ja",
        mcp_tool_name=(mapping["mcp_tool"] if mapping else f"robot_{technique}"),
    )
