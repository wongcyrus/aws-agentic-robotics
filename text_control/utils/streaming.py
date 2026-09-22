"""
Streaming utilities for handling text streams and filtering
"""

import json
import re
import sys
import time
from typing import AsyncGenerator, Dict

TOOL_MARKER_PATTERN = re.compile(
    r"%\[[A-Za-z0-9_.:-]+___[A-Za-z0-9_.:-]+\]%"
)


def strip_tool_markers(text: str) -> str:
    """Remove internal AgentCore Gateway tool markers from response text."""
    return TOOL_MARKER_PATTERN.sub("", text)


class ToolMarkerFilter:
    """Remove tool markers even when they are split across stream chunks."""

    def __init__(self):
        self.buffer = ""

    def process(self, text: str) -> str:
        self.buffer += text
        output = []

        while self.buffer:
            marker_start = self.buffer.find("%[")
            if marker_start == -1:
                if self.buffer.endswith("%"):
                    output.append(self.buffer[:-1])
                    self.buffer = "%"
                else:
                    output.append(self.buffer)
                    self.buffer = ""
                break

            output.append(self.buffer[:marker_start])
            marker_end = self.buffer.find("]%", marker_start + 2)
            if marker_end == -1:
                self.buffer = self.buffer[marker_start:]
                break

            candidate = self.buffer[marker_start : marker_end + 2]
            if not TOOL_MARKER_PATTERN.fullmatch(candidate):
                output.append(candidate)
            self.buffer = self.buffer[marker_end + 2 :]

        return "".join(output)

    def flush(self) -> str:
        output = strip_tool_markers(self.buffer)
        if self.buffer.startswith("%[") and "___" in self.buffer:
            output = ""
        self.buffer = ""
        return output


class ThinkingTagFilter:
    """Filter to remove <thinking>...</thinking> tags from streaming text"""
    
    THINKING_START = "<thinking>"
    THINKING_END = "</thinking>"
    
    def __init__(self):
        self.buffer = ""
        self.inside_thinking = False
        
    def process(self, text: str) -> str:
        """
        Process incoming text and return filtered output without thinking tags.
        
        Args:
            text: Incoming text chunk
            
        Returns:
            Filtered text with thinking tags removed
        """
        self.buffer += text
        output = ""
        
        while True:
            if self.inside_thinking:
                end_idx = self.buffer.find(self.THINKING_END)
                if end_idx == -1:
                    # Keep potential partial match at end
                    self.buffer = self.buffer[-len(self.THINKING_END) + 1:]
                    break
                self.buffer = self.buffer[end_idx + len(self.THINKING_END):]
                self.inside_thinking = False
                continue
            
            start_idx = self.buffer.find(self.THINKING_START)
            if start_idx == -1:
                # Check for partial thinking tag at end of buffer
                for i in range(1, len(self.THINKING_START)):
                    if self.buffer.endswith(self.THINKING_START[:i]):
                        output += self.buffer[:-i]
                        self.buffer = self.buffer[-i:]
                        return output
                
                # No partial match, output entire buffer
                output += self.buffer
                self.buffer = ""
                break
            
            # Found thinking tag start
            output += self.buffer[:start_idx]
            self.buffer = self.buffer[start_idx + len(self.THINKING_START):]
            self.inside_thinking = True
        
        return output
    
    def flush(self) -> str:
        """
        Flush any remaining buffered content.
        
        Returns:
            Any remaining text in buffer if not inside thinking tags
        """
        if not self.inside_thinking and self.buffer:
            output = self.buffer
            self.buffer = ""
            return output
        return ""


class CitationFilter:
    """Filter to remove citation brackets and reference sections from streaming text"""
    
    def __init__(self):
        self.buffer = ""
        self.blocked = False
        self.citation_pattern = re.compile(r'\[[a-zA-Z0-9]+\]')
        
    def process(self, text: str) -> str:
        if self.blocked:
            return ""
            
        self.buffer += text
        
        ref_idx = self.buffer.find("**引用来源**")
        if ref_idx != -1:
            self.buffer = self.buffer[:ref_idx]
            self.blocked = True
            
        self.buffer = self.citation_pattern.sub('', self.buffer)
        
        if self.blocked:
            output = self.buffer
            self.buffer = ""
            return output
            
        reference_str = "**引用来源**"
        
        last_bracket = self.buffer.rfind('[')
        if last_bracket != -1:
            last_close = self.buffer.find(']', last_bracket)
            if last_close == -1 and (len(self.buffer) - last_bracket < 15):
                output = self.buffer[:last_bracket]
                for i in range(1, len(reference_str)):
                    if output.endswith(reference_str[:i]):
                        self.buffer = output[-i:] + self.buffer[last_bracket:]
                        return output[:-i]
                self.buffer = self.buffer[last_bracket:]
                return output
                
        for i in range(1, len(reference_str)):
            if self.buffer.endswith(reference_str[:i]):
                output = self.buffer[:-i]
                self.buffer = self.buffer[-i:]
                return output
                
        output = self.buffer
        self.buffer = ""
        return output
        
    def flush(self) -> str:
        output = self.buffer
        self.buffer = ""
        return output


class MarkdownFilter:
    """Filter to remove markdown characters that are not TTS-friendly"""
    
    def process(self, text: str) -> str:
        # Remove bold/italic asterisks
        text = text.replace("**", "").replace("*", "")
        # Remove headers (### )
        text = text.replace("### ", "").replace("## ", "").replace("# ", "")
        # Remove bullet points
        text = text.replace("- ", "")
        # Replace newlines with spaces or pauses? TTS usually handles newlines okay.
        return text

async def stream_agent_response(
    agent,
    ask_text: str,
    session_id: str,
    trace_id: str,
    extra: Dict
) -> AsyncGenerator[str, None]:
    """
    Stream agent response with thinking tag filtering.
    
    Args:
        agent: Strands agent instance
        ask_text: User's question
        session_id: Session identifier
        trace_id: Request trace identifier
        extra: Extra parameters from request
        
    Yields:
        SSE-formatted data chunks
    """
    from utils.lambda_logger import get_lambda_logger
    logger = get_lambda_logger(__name__)
    
    filter_obj = ThinkingTagFilter()
    tool_marker_filter = ToolMarkerFilter()
    citation_filter = CitationFilter()
    markdown_filter = MarkdownFilter()
    chunk_count = 0
    
    try:
        async for event in agent.stream_async(ask_text):
            # Log the raw event for debugging
            logger.debug(f"Raw event: {event}")
            
            # Skip events that don't have 'data' key
            # The agent emits duplicate events: one with 'event' and one with 'data'
            # We only want to process the 'data' events to avoid duplicates
            if 'data' not in event:
                continue
            
            # Extract text content from event
            event_data = event.get("data", "")
            if not event_data:
                continue
            
            # Convert to string if needed
            if not isinstance(event_data, str):
                event_data = str(event_data)
            
            # Filter thinking tags
            filtered_text = filter_obj.process(event_data)
            filtered_text = tool_marker_filter.process(filtered_text)
            filtered_text = citation_filter.process(filtered_text)
            filtered_text = markdown_filter.process(filtered_text)
            
            if filtered_text:
                chunk_count += 1
                chunk = {
                    "askText": ask_text,
                    "extra": extra,
                    "id": f"{trace_id}_{chunk_count}",
                    "replyPayload": None,
                    "replyText": filtered_text,
                    "replyType": "Llm",
                    "sessionId": session_id,
                    "timestamp": int(time.time() * 1000),
                    "traceId": trace_id,
                    "isFinal": False,
                }
                yield f"data: {json.dumps(chunk)}\n\n"
        
        # Send final buffered content
        remaining = filter_obj.flush()
        remaining = tool_marker_filter.process(remaining)
        remaining += tool_marker_filter.flush()
        remaining = citation_filter.process(remaining)
        remaining += citation_filter.flush()
        remaining = markdown_filter.process(remaining)
        
        if remaining:
            chunk_count += 1
            chunk = {
                "askText": ask_text,
                "extra": extra,
                "id": f"{trace_id}_{chunk_count}",
                "replyPayload": None,
                "replyText": remaining,
                "replyType": "Llm",
                "sessionId": session_id,
                "timestamp": int(time.time() * 1000),
                "traceId": trace_id,
                "isFinal": False,
            }
            yield f"data: {json.dumps(chunk)}\n\n"
        
        # Always send final marker
        chunk_count += 1
        final_chunk = {
            "askText": ask_text,
            "extra": extra,
            "id": f"{trace_id}_{chunk_count}",
            "replyPayload": None,
            "replyText": "",
            "replyType": "Llm",
            "sessionId": session_id,
            "timestamp": int(time.time() * 1000),
            "traceId": trace_id,
            "isFinal": True,
        }
        yield f"data: {json.dumps(final_chunk)}\n\n"
        
    except Exception as e:
        # Yield error chunk
        error_chunk = {
            "askText": ask_text,
            "extra": extra,
            "id": trace_id,
            "replyPayload": None,
            "replyText": f"Error: {str(e)}",
            "replyType": "Error",
            "sessionId": session_id,
            "timestamp": int(time.time() * 1000),
            "traceId": trace_id,
            "isFinal": True,
        }
        yield f"data: {json.dumps(error_chunk)}\n\n"
        raise


def create_sync_stream_wrapper(async_gen):
    """
    Wrap async generator to run in sync context.
    
    Args:
        async_gen: Async generator to wrap
        
    Yields:
        Items from async generator
    """
    import asyncio
    
    loop = asyncio.new_event_loop()
    try:
        while True:
            try:
                chunk = loop.run_until_complete(async_gen.__anext__())
                yield chunk
                # Force flush to prevent log truncation
                sys.stdout.flush()
                sys.stderr.flush()
            except StopAsyncIteration:
                break
    finally:
        loop.close()
