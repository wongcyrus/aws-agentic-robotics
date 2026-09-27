import sys
from types import ModuleType, SimpleNamespace

import auth


def test_generate_iam_policy_contract():
    policy = auth.generate_iam_policy("user-1", "Allow", "arn:method")
    assert policy["principalId"] == "user-1"
    assert policy["policyDocument"]["Statement"][0] == {
        "Action": "execute-api:Invoke",
        "Effect": "Allow",
        "Resource": "arn:method",
    }


def test_auth_handler_denies_missing_token():
    result = auth.auth_handler({"methodArn": "arn:method"}, None)
    assert result["principalId"] == "unauthorized"
    assert result["policyDocument"]["Statement"][0]["Effect"] == "Deny"


def test_auth_handler_denies_when_cognito_configuration_missing(monkeypatch):
    monkeypatch.delenv("COGNITO_USER_POOL_ID", raising=False)
    monkeypatch.delenv("COGNITO_REGION", raising=False)
    result = auth.auth_handler(
        {"methodArn": "arn:method", "headers": {"Authorization": "Bearer token"}}, None
    )
    assert result["policyDocument"]["Statement"][0]["Effect"] == "Deny"


def test_auth_handler_accepts_valid_jwt(monkeypatch):
    monkeypatch.setenv("COGNITO_USER_POOL_ID", "pool")
    monkeypatch.setenv("COGNITO_REGION", "us-east-1")
    monkeypatch.setenv("COGNITO_USER_POOL_CLIENT_ID", "client")

    jwt_module = ModuleType("jwt")
    jwt_module.get_unverified_header = lambda _token: {"kid": "key-1"}
    jwt_module.decode = lambda *args, **kwargs: {"sub": "subject-1"}
    algorithms_module = ModuleType("jwt.algorithms")
    algorithms_module.RSAAlgorithm = SimpleNamespace(from_jwk=lambda key: f"public:{key['kid']}")
    requests_module = ModuleType("requests")
    requests_module.get = lambda *args, **kwargs: SimpleNamespace(
        json=lambda: {"keys": [{"kid": "key-1"}]}
    )
    monkeypatch.setitem(sys.modules, "jwt", jwt_module)
    monkeypatch.setitem(sys.modules, "jwt.algorithms", algorithms_module)
    monkeypatch.setitem(sys.modules, "requests", requests_module)

    result = auth.auth_handler(
        {"methodArn": "arn:method", "queryStringParameters": {"token": "token"}}, None
    )

    assert result["principalId"] == "subject-1"
    assert result["policyDocument"]["Statement"][0]["Effect"] == "Allow"
