import json
import os
import re
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
OUTPUT_FILE = PROJECT_ROOT / "cdk" / "output.json"


def get_stack_output(name: str) -> str:
    snake_case_name = re.sub(r"(?<!^)(?=[A-Z])", "_", name).upper()
    environment_value = (
        os.environ.get(name)
        or os.environ.get(name.upper())
        or os.environ.get(snake_case_name)
    )
    if environment_value:
        return environment_value

    try:
        outputs = json.loads(OUTPUT_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise RuntimeError(
            f"{OUTPUT_FILE} does not exist. Deploy the stack or set {name}."
        ) from error

    if not isinstance(outputs, dict) or len(outputs) != 1:
        raise RuntimeError(
            f"Expected exactly one stack in {OUTPUT_FILE}, found {len(outputs)}."
        )

    stack_outputs = next(iter(outputs.values()))
    value = stack_outputs.get(name)
    if not value:
        raise RuntimeError(f"Stack output {name} is missing from {OUTPUT_FILE}.")
    return str(value)
