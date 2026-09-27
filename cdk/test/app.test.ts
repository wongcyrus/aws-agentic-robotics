import { beforeEach, describe, expect, jest, test } from "@jest/globals";

const mockStackConstructor = jest.fn();
const mockDomainV2StackConstructor = jest.fn();
const mockSynth = jest.fn();
const mockExistsSync = jest.fn(() => false);
const mockReadFileSync = jest.fn();
const mockContext: Record<string, unknown> = {};

jest.mock("aws-cdk-lib", () => ({
  App: class {
    synth = mockSynth;
    node = {
      tryGetContext: (key: string) => mockContext[key],
    };
  },
}));

jest.mock("../lib/cdk-stack", () => ({
  AwsAgenticRoboticsStack: class {
    constructor(...args: unknown[]) {
      mockStackConstructor(...args);
    }
  },
}));

jest.mock("../lib/domain-expansion-v2-stack", () => ({
  DomainExpansionV2Stack: class {
    constructor(...args: unknown[]) {
      mockDomainV2StackConstructor(...args);
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
    mockDomainV2StackConstructor.mockClear();
    mockSynth.mockClear();
    mockExistsSync.mockReset().mockReturnValue(false);
    mockReadFileSync.mockReset();
    delete process.env.TEST_SIMPLE;
    delete process.env.TEST_QUOTED;
    delete process.env.TEST_EQUALS;
    for (const key of Object.keys(mockContext)) delete mockContext[key];
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

  test("creates only the V2 stack from complete deployment context", () => {
    Object.assign(mockContext, {
      OnlyDomainV2: "true",
      DomainV2UserPoolId: "pool",
      DomainV2UserPoolClientId: "client",
      DomainV2CommentatorRuntimeArn: "commentator",
      DomainV2OpenClawRuntimeArn: "openclaw",
      DomainV2RobotApiEndpoint: "https://robot.example.test",
      DomainV2RobotGatewayUrl: "https://gateway.example.test",
    });

    jest.isolateModules(() => {
      require("../bin/cdk");
    });

    expect(mockStackConstructor).not.toHaveBeenCalled();
    expect(mockDomainV2StackConstructor).toHaveBeenCalledWith(
      expect.anything(),
      "DomainExpansionV2",
      expect.objectContaining({
        stackName: "domain-expansion-v2",
        userPoolId: "pool",
        userPoolClientId: "client",
      })
    );
    expect(mockSynth).toHaveBeenCalledTimes(1);
  });

  test("rejects incomplete V2 deployment context", () => {
    mockContext.OnlyDomainV2 = "true";

    expect(() => {
      jest.isolateModules(() => {
        require("../bin/cdk");
      });
    }).toThrow("Missing required CDK context: DomainV2UserPoolId");
    expect(mockDomainV2StackConstructor).not.toHaveBeenCalled();
    expect(mockSynth).not.toHaveBeenCalled();
  });
});
