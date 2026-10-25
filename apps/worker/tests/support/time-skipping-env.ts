import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker, type ActivityInterface, type WorkflowBundleOptions } from "@temporalio/worker";

/**
 * Real-sandbox test environment for the workflow suite (CORE-006).
 *
 * `TestWorkflowEnvironment.createTimeSkipping()` downloads the Temporal test
 * server on first use. In offline or mirrored environments, point
 * `SPACE_TEST_TEMPORAL_TEST_SERVER` at an existing `temporal-test-server`
 * executable (any recent sdk-java release) and it is used instead.
 */
export function timeSkippingServerExecutable(): { type: "existing-path"; path: string } | undefined {
  const path = process.env.SPACE_TEST_TEMPORAL_TEST_SERVER?.trim();
  return path ? { type: "existing-path", path } : undefined;
}

/** Create a time-skipping Temporal test environment for the sandbox suite. */
export async function createTimeSkippingEnvironment(): Promise<TestWorkflowEnvironment> {
  const executable = timeSkippingServerExecutable();
  return TestWorkflowEnvironment.createTimeSkipping(
    executable ? { server: { executable } } : undefined
  );
}

/** Options for creating a sandbox worker in the test environment. */
export interface SandboxWorkerOptions {
  taskQueue: string;
  workflowsPath: string;
  activities: ActivityInterface;
}

/**
 * A worker for the test environment. `worker.run()` (no arguments; the worker
 * polls until shutdown) is returned as `running` so tests can drive clients
 * freely and `afterAll` can await a clean stop.
 */
export async function createSandboxWorker(
  env: TestWorkflowEnvironment,
  options: SandboxWorkerOptions
): Promise<{ worker: Worker; running: Promise<void> }> {
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: options.taskQueue,
    workflowsPath: options.workflowsPath as WorkflowBundleOptions extends never ? never : string,
    activities: options.activities,
    isolateExecutionTimeout: "30 seconds"
  });
  return { worker, running: worker.run() };
}

/** Stop a sandbox worker and await its running promise. */
export async function stopSandboxWorker(
  bundle: { worker: Worker; running: Promise<void> } | undefined
): Promise<void> {
  if (!bundle) return;
  await bundle.worker.shutdown();
  await bundle.running;
}
