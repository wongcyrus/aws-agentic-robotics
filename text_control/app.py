"""Flask application for robot text control with AWS integration."""
import atexit
import json
import logging
import os
from functools import partial

import awsgi2
from flask import Flask, request
from flask_caching import Cache

from config import DEBUG
from errors import register_error_handlers
from mcp_client import cleanup_mcp_client, get_mcp_client
from utils.observability import request_summary

# Configure logging for development environment
if not os.getenv("AWS_LAMBDA_FUNCTION_NAME"):
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    )
    print("Initializing MCP client with AWS SigV4 authentication")

# Import and register blueprints after app is created to avoid circular imports
from routes.api import api_bp  # pylint: disable=wrong-import-position
from routes.auth import auth_bp  # pylint: disable=wrong-import-position
from routes.ui import ui_bp  # pylint: disable=wrong-import-position

DEFAULT_CONFIG = {
    "DEBUG": DEBUG,  # some Flask specific configs
    "CACHE_TYPE": "SimpleCache",  # Flask-Caching related configs
    "CACHE_DEFAULT_TIMEOUT": 300,
    "SECRET_KEY": os.getenv(
        "FlaskSecretKey", "fallback-secret-key-for-lambda-sessions-12345"
    ),  # Required for sessions - use a consistent fallback for Lambda
}

BINARY_CONTENT_TYPES = {
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/vnd.microsoft.icon",
    "image/webp",
}


def summarize_lambda_event(event):
    """Extract non-sensitive routing metadata from a Lambda event."""
    if not isinstance(event, dict):
        return {"method": "UNKNOWN", "path": "UNKNOWN"}
    request_context = event.get("requestContext", {})
    http_context = request_context.get("http", {})
    return {
        "method": event.get("httpMethod") or http_context.get("method", "UNKNOWN"),
        "path": event.get("path") or http_context.get("path", "UNKNOWN"),
        "requestId": request_context.get("requestId"),
    }


def log_request_info():
    """Log non-sensitive request routing metadata."""
    try:
        print(json.dumps({"event": "http_request", **request_summary(request)}), flush=True)
    except Exception as e:
        print(f"Error in request logging hook: {str(e)}", flush=True)


def after_request(response):
    """Add CORS headers to all responses."""
    response.headers.add("Access-Control-Allow-Origin", "*")
    response.headers.add(
        "Access-Control-Allow-Headers", "Content-Type,Authorization"
    )
    response.headers.add(
        "Access-Control-Allow-Methods", "GET,PUT,POST,DELETE,OPTIONS"
    )
    return response


def create_app(config_overrides=None, initialize_mcp=True):
    """Create the Flask application with optional startup side effects."""
    flask_app = Flask(__name__)
    flask_app.config.from_mapping(DEFAULT_CONFIG)
    if config_overrides:
        flask_app.config.from_mapping(config_overrides)

    flask_app.cache = Cache(flask_app)
    flask_app.before_request(log_request_info)
    flask_app.after_request(after_request)
    flask_app.register_blueprint(api_bp)
    flask_app.register_blueprint(ui_bp)
    flask_app.register_blueprint(auth_bp)
    register_error_handlers(flask_app)

    if initialize_mcp:
        with flask_app.app_context():
            get_mcp_client()

    return flask_app


app = create_app()

# Register cleanup function to run at exit
atexit.register(cleanup_mcp_client)


def handle_lambda_request(
    event,
    context,
    application=None,
    response_adapter=None,
    invocation_notifier=None,
):
    """AWS Lambda handler for the Flask application"""
    try:
        summary = summarize_lambda_event(event)
        print(json.dumps({"event": "lambda_invocation", **summary}), flush=True)
    except Exception as e:
        print(f"Error logging Lambda event: {e}")

    try:
        if invocation_notifier is None:
            from mcp_client import notify_new_invocation

            invocation_notifier = notify_new_invocation
        if hasattr(context, "aws_request_id"):
            invocation_notifier(context.aws_request_id)
    except Exception as e:
        print(f"Error notifying new invocation to MCP client: {e}")
    responder = response_adapter or partial(
        awsgi2.response,
        base64_content_types=BINARY_CONTENT_TYPES,
    )
    return responder(application or app, event, context)


def handler(event, context):
    """AWS Lambda entry point."""
    return handle_lambda_request(event, context)


if __name__ == "__main__":
    print("🤖 Starting Robot Text Control with Strands Agents...")
    print("📡 Streaming endpoint: /api/talk")
    print("🔄 Non-streaming endpoint: /xiaoice-chat-api-strands")
    print("🌐 Original endpoint: /xiaoice-chat-api")
    # app.run(debug=DEBUG)
    app.run(host="0.0.0.0", debug=DEBUG)
