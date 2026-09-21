# Text Control Tests

This directory contains test scripts for the text control service.

## Test Files

### `test_empty_asktext.py`
Tests input validation for empty or blank text parameters across all endpoints.

**Usage:**
```bash
python test_empty_asktext.py
```

**Tests:**
- Empty string validation
- Whitespace-only input rejection
- Proper error response format
- All affected endpoints

### `test_streaming.py`
Tests streaming endpoints with various scenarios.

**Usage:**
```bash
# Run all streaming tests
python test_streaming.py

# Test specific streaming type
python test_streaming.py xiaoice    # XiaoIce streaming endpoint
python test_streaming.py talk       # Talk streaming endpoint  
python test_streaming.py continuity # Conversation continuity
```

**Tests:**
- SSE streaming functionality
- Authentication with signatures
- Multi-message conversations
- Error handling

## Running Tests

### Prerequisites

1. **Start the application server:**
   From the repository root:
   ```bash
   cd text_control
   python app.py
   ```

2. **Set credentials for the Xiaoice-compatible endpoints:**
   ```bash
   export XiaoiceChatSecretKey="your_secret_key"
   export XiaoiceChatAccessKey="your_access_key"
   ```

   If you use project-specific credentials, make sure the same access key / secret key pair is available to the app through Secrets Manager, `XIAOICE_PROJECT_CREDENTIALS`, or `xiaoice_credentials.json`.

### Test Execution

```bash
# Run individual tests
python tests/test_empty_asktext.py
python tests/test_streaming.py

# Run with specific parameters
python tests/test_streaming.py talk
```

## Expected Results

### Input Validation Tests
- All empty/blank inputs should return HTTP 400
- Error messages should be clear and actionable
- All endpoints should handle validation consistently

### Streaming Tests
- Successful authentication should return HTTP 200
- SSE streams should deliver data in proper format
- Conversation continuity should maintain session context

## Troubleshooting

### Common Issues

1. **Connection Refused**
   - Ensure the application server is running on port 5000
   - Check firewall settings

2. **Authentication Errors**
   - Verify the access key and secret key pair matches what the app is using
   - Check whether the endpoint expects signature v2 (`/api/talk`) or legacy signature (`/api/xiaoice-chat-api-strands*`)

3. **Timeout Errors**
   - Increase timeout values for slow responses
   - Check AWS service connectivity

### Debug Mode

Add debug output to tests:
```python
import logging
logging.basicConfig(level=logging.DEBUG)
```
