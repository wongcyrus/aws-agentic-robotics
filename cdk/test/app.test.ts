import { beforeEach, describe, expect, jest, test } from "@jest/globals";

const mockStackConstructor = jest.fn();
const mockSynth = jest.fn();
const mockExistsSync = jest.fn(() => false);
const mockReadFileSync = jest.fn();

jest.mock("aws-cdk-lib", () => ({
  App: class {
    synth = mockSynth;
  },
}));

jest.mock("../lib/cdk-stack", () => ({
  AwsAgenticRoboticsStack: class {
    constructor(...args: unknown[]) {
      mockStackConstructor(...args);
    }
  },
}));

jest.mock("fs", () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
}));

describe("CDK app entrypoint", () => {
  beforeEach(() => {
    jest.resetModules();
    mockStackConstructor.mockClear();
    mockSynth.mockClear();
    mockExistsSync.mockReset().mockReturnValue(false);
    mockReadFileSync.mockReset();
    delete process.env.TEST_SIMPLE;
    delete process.env.TEST_QUOTED;
    delete process.env.TEST_EQUALS;
  });

  test("instantiates and synthesizes the intended stack identity", () => {
    jest.isolateModules(() => {
      require("../bin/cdk");
    });

    expect(mockStackConstructor).toHaveBeenCalledTimes(1);
    expect(mockStackConstructor).toHaveBeenCalledWith(
      expect.anything(),
      "AwsAgenticRobotics",
      { stackName: "aws-agentic-robotics" }
    );
    expect(mockSynth).toHaveBeenCalledTimes(1);
  });

  test("loads supported dotenv values before creating the stack", () => {
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      [
        "# comment",
        "",
        "not-an-assignment",
        "TEST_SIMPLE=value",
        'TEST_QUOTED="quoted value"',
        "TEST_EQUALS=left=right",
      ].join("\n")
    );

    jest.isolateModules(() => {
      require("../bin/cdk");
    });

    expect(process.env.TEST_SIMPLE).toBe("value");
    expect(process.env.TEST_QUOTED).toBe("quoted value");
    expect(process.env.TEST_EQUALS).toBe("left=right");
    expect(logSpy).toHaveBeenCalledWith(
      "✅ Loaded environment variables from cdk/.env"
    );
    logSpy.mockRestore();
  });

  test("warns but still synthesizes when dotenv loading fails", () => {
    const warnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const error = new Error("read failed");
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => {
      throw error;
    });

    jest.isolateModules(() => {
      require("../bin/cdk");
    });

    expect(warnSpy).toHaveBeenCalledWith(
      "⚠️ Failed to load cdk/.env:",
      error
    );
    expect(mockStackConstructor).toHaveBeenCalledTimes(1);
    expect(mockSynth).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});
