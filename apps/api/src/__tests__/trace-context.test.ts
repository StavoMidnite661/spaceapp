import { describe, expect, it } from "vitest";
import { childTraceparent, createRequestTraceContext, requestTraceContexts, traceparentForTraceId, withTurnTraceparent, workflowCorrelationMemo } from "../trace-context.js";
import { parseTraceparent } from "@space/contracts";

describe("trace context propagation", () => {
  it("creates a W3C trace context from scratch", () => {
    const context = createRequestTraceContext(undefined);
    expect(context.w3cTraceId).toMatch(/^[0-9a-f]{32}$/);
    expect(context.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(context.parentSpanId).toBeNull();
    expect(context.inbound).toBe(false);
    expect(parseTraceparent(context.traceparent)).not.toBeNull();
  });

  it("creates a child traceparent sharing the trace id with new span", () => {
    const context = createRequestTraceContext(undefined);
    const child = childTraceparent(context.traceparent);
    expect(child).not.toBeNull();
    const parsed = parseTraceparent(child!);
    expect(parsed!.traceId).toBe(context.w3cTraceId);
    expect(parsed!.parentId).not.toBe(context.spanId);
  });

  it("traceparentForTraceId returns null for unknown request id", () => {
    expect(traceparentForTraceId("req:unknown")).toBeNull();
  });

  it("traceparentForTraceId returns child traceparent for known request id", () => {
    const context = createRequestTraceContext(undefined);
    requestTraceContexts.remember("req:test-1", context);
    const child = traceparentForTraceId("req:test-1");
    expect(child).not.toBeNull();
    const parsed = parseTraceparent(child!);
    expect(parsed!.traceId).toBe(context.w3cTraceId);
    expect(parsed!.parentId).not.toBe(context.spanId);
  });

  it("workflowCorrelationMemo encodes traceId and traceparent", () => {
    const context = createRequestTraceContext(undefined);
    const memo = workflowCorrelationMemo({ traceId: "req:test-1", traceparent: context.traceparent });
    expect(memo.spaceTraceId).toBe("req:test-1");
    expect(memo.traceparent).toBe(context.traceparent);
    expect(memo.w3cTraceId).toBe(context.w3cTraceId);
  });

  it("workflowCorrelationMemo omits unset fields", () => {
    const memo = workflowCorrelationMemo({ traceId: null });
    expect(memo.spaceTraceId).toBeUndefined();
    expect(memo.traceparent).toBeUndefined();
    expect(memo.w3cTraceId).toBeUndefined();
  });

  it("workflowCorrelationMemo filters invalid traceId", () => {
    const memo = workflowCorrelationMemo({ traceId: "invalid id with spaces" });
    expect(memo.spaceTraceId).toBeUndefined();
  });

  it("withTurnTraceparent adds traceparent when missing", () => {
    const context = createRequestTraceContext(undefined);
    requestTraceContexts.remember("req:test-2", context);
    const turn = { traceId: "req:test-2" };
    const result = withTurnTraceparent(turn);
    const parsed = parseTraceparent(result.traceparent!);
    expect(parsed!.traceId).toBe(context.w3cTraceId);
    expect(parsed!.parentId).not.toBe(context.spanId);
  });

  it("withTurnTraceparent keeps existing valid traceparent", () => {
    const context = createRequestTraceContext(undefined);
    const turn = { traceId: "req:any", traceparent: context.traceparent };
    const result = withTurnTraceparent(turn);
    expect(result.traceparent).toBe(context.traceparent);
  });
});
