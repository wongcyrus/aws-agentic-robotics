import asyncio
from types import SimpleNamespace

import httpx
import pytest

import mcp_client


class FakeNativeClient:
    def __init__(self, transport, startup_timeout):
        self.transport = transport
        self.startup_timeout = startup_timeout
        self.started = 0
        self.stopped = 0
        self.tool_results = []
        self.list_results = []

    def start(self):
        self.started += 1

    def stop(self, *_args):
        self.stopped += 1

    def call_tool_sync(self, **_kwargs):
        result = self.tool_results.pop(0)
        if isinstance(result, Exception):
            raise result
        return result

    def list_tools_sync(self, **_kwargs):
        result = self.list_results.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


def test_resolvers_and_tool_result_conversion(monkeypatch):
    monkeypatch.delenv("AWS_REGION", raising=False)
    monkeypatch.delenv("AWS_DEFAULT_REGION", raising=False)
    monkeypatch.delenv("MCP_AWS_SERVICE", raising=False)
    monkeypatch.setattr(
        mcp_client.boto3,
        "Session",
        lambda **_kwargs: SimpleNamespace(region_name=None),
    )
    url = "https://example.bedrock-agentcore.ap-southeast-1.amazonaws.com"
    assert mcp_client._resolve_region(url) == "ap-southeast-1"
    assert mcp_client._resolve_service(url) == "bedrock-agentcore"
    assert mcp_client._resolve_service("https://lambda.example") == "lambda"
    assert mcp_client._convert_tool_result_to_dict({"ok": True}) == {"ok": True}
    assert mcp_client._convert_tool_result_to_dict("value")["content"][0]["text"] == "value"

    result = SimpleNamespace(
        toolUseId="id",
        isError=False,
        content=[SimpleNamespace(type="text", text="done"), SimpleNamespace(value=3)],
    )
    converted = mcp_client._convert_tool_result_to_dict(result)
    assert converted["toolUseId"] == "id"
    assert converted["content"][1]["text"] == 3


def test_resolvers_honor_explicit_environment_and_credentials(monkeypatch):
    monkeypatch.setenv("AWS_REGION", "eu-west-1")
    monkeypatch.setenv("MCP_AWS_SERVICE", "execute-api")
    frozen = SimpleNamespace(access_key="key")
    monkeypatch.setattr(
        mcp_client.boto3,
        "Session",
        lambda **kwargs: SimpleNamespace(
            get_credentials=lambda: SimpleNamespace(
                get_frozen_credentials=lambda: frozen
            )
        ),
    )
    assert mcp_client._resolve_region("https://example.com") == "eu-west-1"
    assert mcp_client._resolve_service("https://example.com") == "execute-api"
    assert mcp_client._resolve_frozen_credentials("https://example.com") is frozen


def test_sigv4_auth_requires_credentials(monkeypatch):
    monkeypatch.setattr(mcp_client, "_resolve_frozen_credentials", lambda _url: None)
    request = httpx.Request("POST", "https://example.com", content=b"{}")
    with pytest.raises(RuntimeError, match="Missing AWS credentials"):
        next(mcp_client.AwsSigV4Auth("https://example.com").auth_flow(request))


def test_sigv4_auth_adds_signed_headers(monkeypatch):
    monkeypatch.setattr(
        mcp_client,
        "_resolve_frozen_credentials",
        lambda _url: SimpleNamespace(),
    )
    monkeypatch.setattr(mcp_client, "_resolve_region", lambda _url: "us-east-1")
    monkeypatch.setattr(mcp_client, "_resolve_service", lambda _url: "service")

    class Request:
        def __init__(self, **kwargs):
            self.headers = {"Authorization": "signed", "X-Test": "value"}

    monkeypatch.setattr(mcp_client, "AWSRequest", Request)
    monkeypatch.setattr(
        mcp_client,
        "BotocoreSigV4Auth",
        lambda *args: SimpleNamespace(add_auth=lambda request: None),
    )
    request = httpx.Request(
        "POST",
        "https://example.com",
        headers={"connection": "keep-alive"},
        content=b"{}",
    )
    signed = next(mcp_client.AwsSigV4Auth("https://example.com").auth_flow(request))
    assert signed.headers["Authorization"] == "signed"
    assert signed.headers["X-Test"] == "value"


def test_secure_client_call_retry_list_cache_and_close(monkeypatch):
    created = []

    def factory(*args, **kwargs):
        client = FakeNativeClient(*args, **kwargs)
        created.append(client)
        return client

    client = mcp_client.SecureMCPClient("https://example.com", client_factory=factory)
    created[0].tool_results = [RuntimeError("stale")]
    original_recreate = client._recreate_client

    async def recreate():
        await original_recreate()
        created[-1].tool_results = [{"content": []}]

    monkeypatch.setattr(client, "_recreate_client", recreate)
    assert asyncio.run(client.call_tool("robot_wave")) == {"content": []}
    assert len(created) == 2

    tool = SimpleNamespace(name="robot_wave", _tool_spec={"description": "Wave"})

    class Page(list):
        pagination_token = None

    created[-1].list_results = [Page([tool])]
    tools = asyncio.run(client.list_tools())
    assert tools[0].tool_name == "robot_wave"
    assert tools[0].description == "Wave"
    assert asyncio.run(client.list_tools()) is tools
    asyncio.run(client.close())
    assert created[-1].stopped == 1


def test_secure_client_raises_domain_error_after_retry(monkeypatch):
    created = []

    def factory(*args, **kwargs):
        client = FakeNativeClient(*args, **kwargs)
        client.tool_results = [RuntimeError("down")]
        created.append(client)
        return client

    client = mcp_client.SecureMCPClient("https://example.com", client_factory=factory)
    with pytest.raises(mcp_client.MCPError, match="after retry"):
        asyncio.run(client.call_tool("robot_wave"))
    assert len(created) == 2


def test_secure_client_list_retry_pagination_and_mcp_metadata(monkeypatch):
    created = []

    class Page(list):
        def __init__(self, items, token):
            super().__init__(items)
            self.pagination_token = token

    def factory(*args, **kwargs):
        client = FakeNativeClient(*args, **kwargs)
        created.append(client)
        return client

    client = mcp_client.SecureMCPClient("https://example.com", client_factory=factory)
    created[0].list_results = [RuntimeError("stale")]
    original_recreate = client._recreate_client

    async def recreate():
        await original_recreate()
        created[-1].list_results = [
            Page(
                [
                    SimpleNamespace(
                        mcp_tool=SimpleNamespace(name="wave", description="Wave")
                    )
                ],
                "next",
            ),
            Page([SimpleNamespace(name="stop", description="Stop")], None),
        ]

    monkeypatch.setattr(client, "_recreate_client", recreate)
    tools = asyncio.run(client.list_tools())
    assert [tool.tool_name for tool in tools] == ["wave", "stop"]
    assert tools[0].description == "Wave"


def test_secure_client_context_and_stop_failures(monkeypatch):
    client = mcp_client.SecureMCPClient(
        "https://example.com",
        client_factory=FakeNativeClient,
    )
    client._client.stop = lambda *_args: (_ for _ in ()).throw(RuntimeError("stop"))
    asyncio.run(client._recreate_client())
    assert asyncio.run(client.__aenter__()) is client
    assert asyncio.run(client.__aexit__(None, None, None)) is None


def test_global_client_lifecycle(monkeypatch):
    monkeypatch.setattr(mcp_client, "_mcp_client", None)
    monkeypatch.setattr(mcp_client, "MCP_SERVER_URL", "")
    with pytest.raises(ValueError, match="not configured"):
        mcp_client.get_mcp_client()

    closed = []

    class Client:
        async def close(self):
            closed.append(True)

    monkeypatch.setattr(mcp_client, "_mcp_client", Client())
    mcp_client.cleanup_mcp_client()
    assert closed == [True]
    assert mcp_client._mcp_client is None


def test_global_client_creation_and_invocation_recycling(monkeypatch):
    created = []
    monkeypatch.setattr(mcp_client, "_mcp_client", None)
    monkeypatch.setattr(mcp_client, "MCP_SERVER_URL", "https://gateway")
    monkeypatch.setenv("MCP_USE_AWS_AUTH", "false")
    monkeypatch.setattr(
        mcp_client,
        "SecureMCPClient",
        lambda url, use_aws_auth: created.append((url, use_aws_auth)) or object(),
    )
    first = mcp_client.get_mcp_client()
    assert first is mcp_client.get_mcp_client()
    assert created == [("https://gateway", False)]

    cleaned = []
    monkeypatch.setattr(mcp_client, "_last_request_id", None)
    monkeypatch.setattr(mcp_client, "_last_invocation_time", None)
    monkeypatch.setattr(mcp_client, "cleanup_mcp_client", lambda: cleaned.append(True))
    monkeypatch.setattr(mcp_client.time, "time", lambda: 1000)
    mcp_client.notify_new_invocation("request-1")
    assert cleaned == [True]

    monkeypatch.setattr(mcp_client, "_last_invocation_time", 500)
    mcp_client.notify_new_invocation("request-2")
    assert cleaned == [True, True]
