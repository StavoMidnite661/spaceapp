import assert from "node:assert/strict";
import test from "node:test";
import {
  composeCommand,
  createDefaultConfig,
  installResourceChecks,
  resolveInstallEngine,
  validateConfig
} from "../src/index.mjs";

test("resolveInstallEngine defaults to docker", () => {
  assert.equal(resolveInstallEngine(undefined), "docker");
  assert.equal(resolveInstallEngine(undefined, "podman"), "podman");
});

test("resolveInstallEngine accepts docker and podman", () => {
  assert.equal(resolveInstallEngine("docker"), "docker");
  assert.equal(resolveInstallEngine("podman"), "podman");
});

test("resolveInstallEngine rejects invalid engines", () => {
  assert.throws(() => resolveInstallEngine("containerd"), /engine must be docker or podman/);
  assert.throws(() => resolveInstallEngine("k3s"), /engine must be docker or podman/);
});

test("createDefaultConfig includes engine docker by default", () => {
  const config = createDefaultConfig({ version: "0.1.0" });
  assert.equal(config.engine, "docker");
});

test("createDefaultConfig accepts explicit engine", () => {
  const config = createDefaultConfig({ version: "0.1.0", engine: "podman" });
  assert.equal(config.engine, "podman");
});

test("validateConfig defaults missing engine to docker", () => {
  const config = {
    schemaVersion: 4, version: "0.1.0", previousVersion: null,
    bindHost: "127.0.0.1", port: 4911, telemetry: false,
    profile: "light", accessMode: "isolated",
    companionsEnabled: false, optionalModules: "none", workspaces: []
  };
  validateConfig(config);
  assert.equal(config.engine, "docker");
});

test("validateConfig rejects invalid engines", () => {
  assert.throws(
    () => validateConfig({ schemaVersion: 4, version: "0.1.0", previousVersion: null, bindHost: "127.0.0.1", port: 4911, telemetry: false, profile: "light", accessMode: "isolated", engine: "containerd" }),
    /engine must be docker or podman/
  );
});

test("composeCommand uses docker command by default", () => {
  const root = "/tmp/test-spaceapp";
  const result = composeCommand("up", root, { profile: "standard" });
  assert.equal(result.command, "docker");
  assert.ok(result.args.includes("compose"));
  assert.ok(result.args.includes("--project-name"));
});

test("composeCommand uses podman command when engine is podman", () => {
  const root = "/tmp/test-spaceapp";
  const result = composeCommand("up", root, { profile: "standard", engine: "podman" });
  assert.equal(result.command, "podman");
  assert.ok(result.args.includes("compose"));
});

test("installResourceChecks uses engine-specific names", () => {
  const resources = { cpuCount: 4, totalMemoryBytes: 16 * 1024 ** 3, freeDiskBytes: 100 * 1024 ** 3, engineCpuCount: 4, engineMemoryBytes: 8 * 1024 ** 3 };
  const checks = installResourceChecks(resources, "small", { engine: "podman" });
  const cpuCheck = checks.find((c) => c.name === "Podman CPU");
  const memCheck = checks.find((c) => c.name === "Podman memory");
  assert.ok(cpuCheck, "Podman CPU check should exist");
  assert.ok(memCheck, "Podman memory check should exist");
  assert.ok(cpuCheck.ok);
  assert.ok(memCheck.ok);
});

test("installResourceChecks uses Docker names by default", () => {
  const resources = { cpuCount: 4, totalMemoryBytes: 16 * 1024 ** 3, freeDiskBytes: 100 * 1024 ** 3, engineCpuCount: 4, engineMemoryBytes: 8 * 1024 ** 3 };
  const checks = installResourceChecks(resources, "small");
  const cpuCheck = checks.find((c) => c.name === "Docker CPU");
  const memCheck = checks.find((c) => c.name === "Docker memory");
  assert.ok(cpuCheck, "Docker CPU check should exist");
  assert.ok(memCheck, "Docker memory check should exist");
});

test("composeCommand includes profiles for browser and temporal", () => {
  const root = "/tmp/test-spaceapp";
  const result = composeCommand("up", root, {
    profile: "standard",
    engine: "podman",
    companionsEnabled: true
  });
  assert.ok(result.args.includes("--profile"));
  assert.ok(result.args.includes("standard"));
  assert.ok(result.args.includes("workflows"));
  assert.ok(result.args.includes("companions"));
});
