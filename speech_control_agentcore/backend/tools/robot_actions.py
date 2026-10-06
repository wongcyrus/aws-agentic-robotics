import logging
import os
from typing import Any

from tools.mcp_client import get_mcp_client

logger = logging.getLogger(__name__)

# Comma-separated prefixes to include from MCP tools/list.
# Default keeps robot and digital-human controls and excludes unrelated MCP tools.
MCP_TOOL_PREFIX_ALLOW = os.environ.get(
    "MCP_TOOL_PREFIX_ALLOW", "robot_,xiaoice_,digital_"
)

# Comma-separated exact names to exclude.
MCP_TOOL_EXCLUDE = os.environ.get("MCP_TOOL_EXCLUDE", "")
MCP_TOOL_NAME_ALLOW = os.environ.get("MCP_TOOL_NAME_ALLOW", "")

_ALLOWED_PREFIXES = tuple(
    prefix.strip() for prefix in MCP_TOOL_PREFIX_ALLOW.split(",") if prefix.strip()
)
_EXCLUDED_NAMES = {
    name.strip() for name in MCP_TOOL_EXCLUDE.split(",") if name.strip()
}
_ALLOWED_NAMES = {
    name.strip() for name in MCP_TOOL_NAME_ALLOW.split(",") if name.strip()
}

_DYNAMIC_TOOLS_CACHE = None


def _tool_name(tool: Any) -> str:
    if hasattr(tool, "mcp_tool") and hasattr(tool.mcp_tool, "name"):
        return tool.mcp_tool.name
    if hasattr(tool, "tool_name"):
        return tool.tool_name
    if isinstance(tool, dict):
        return tool.get("name", "")
    return ""


def _matches_allowed_prefix(tool: Any) -> bool:
    if not _ALLOWED_PREFIXES:
        return True
    return _tool_name(tool).startswith(_ALLOWED_PREFIXES)


def _matches_allowed_name(tool: Any) -> bool:
    if not _ALLOWED_NAMES:
        return True
    return _tool_name(tool) in _ALLOWED_NAMES


def _matches_excluded_name(tool: Any) -> bool:
    if not _EXCLUDED_NAMES:
        return False
    return _tool_name(tool) in _EXCLUDED_NAMES


def _build_tool_filters() -> dict | None:
    filters = {}

    if _ALLOWED_NAMES:
        filters["allowed"] = [_matches_allowed_name]

    if _ALLOWED_PREFIXES:
        existing_allowed = filters.get("allowed", [])
        existing_allowed.append(_matches_allowed_prefix)
        filters["allowed"] = existing_allowed

    if _EXCLUDED_NAMES:
        filters["rejected"] = [_matches_excluded_name]

    return filters or None


def get_dynamic_tools() -> list:
    """Load AgentCore Gateway tools through the native Strands MCP client."""
    global _DYNAMIC_TOOLS_CACHE

    if _DYNAMIC_TOOLS_CACHE is not None:
        return _DYNAMIC_TOOLS_CACHE

    mcp_client = get_mcp_client()
    tool_filters = _build_tool_filters()
    dynamic_tools = []
    pagination_token = None

    logger.info(
        "Starting MCP tool discovery. allowed_names=%s allowed_prefixes=%s excluded_names=%s",
        sorted(_ALLOWED_NAMES),
        list(_ALLOWED_PREFIXES),
        sorted(_EXCLUDED_NAMES),
    )

    try:
        while True:
            paginated_tools = mcp_client.list_tools_sync(
                pagination_token=pagination_token,
                tool_filters=tool_filters,
            )
            page_tools = list(paginated_tools)
            logger.info(
                "MCP tools page received. count=%d names=%s",
                len(page_tools),
                [_tool_name(tool) for tool in page_tools],
            )
            dynamic_tools.extend(page_tools)
            pagination_token = paginated_tools.pagination_token
            if pagination_token is None:
                break
    except Exception:
        logger.exception("MCP tool discovery failed.")
        raise

    logger.info(
        "Loaded %d MCP tools through native Strands MCPClient. tool_names=%s",
        len(dynamic_tools),
        [_tool_name(tool) for tool in dynamic_tools],
    )
    _DYNAMIC_TOOLS_CACHE = dynamic_tools
    return _DYNAMIC_TOOLS_CACHE
