import sys
import unittest
from pathlib import Path

MODULE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MODULE_DIR))

import tools


class ToolsTests(unittest.TestCase):
    def test_tool_specs_match_action_catalog(self):
        names = [tool["toolSpec"]["name"] for tool in tools.TOOLS]
        self.assertEqual(names, [tool["name"] for tool in tools.TOOL_LIST])
        self.assertEqual(set(names), set(tools.ACTIONS))
        self.assertEqual(len(names), len(set(names)))

    def test_tool_specs_use_the_default_empty_input_schema(self):
        for tool in tools.TOOLS:
            schema = tool["toolSpec"]["inputSchema"]["json"]
            self.assertEqual(schema, tools.DEFAULT_TOOL_SCHEMA)
            self.assertTrue(tool["toolSpec"]["description"])

    def test_dance_ten_keeps_hardware_action_44(self):
        self.assertEqual(tools.ACTIONS["dance_ten"]["action"], ["44", "1"])
        self.assertEqual(tools.ACTIONS["dance_ten"]["sleep_time"], 85)


if __name__ == "__main__":
    unittest.main()
