import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import { streamOpenAIResponses } from "../src/providers/openai-responses.js";

// GitHub Copilot's endpoints reject the service_tier parameter outright
// (400 "service_tier is not supported"), while OpenAI's own Responses API
// accepts it. Regression test: service_tier must be omitted for
// github-copilot models but still sent for other providers.

const mockState = vi.hoisted(() => ({
	lastParams: undefined as unknown,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		responses = {
			create: (params: unknown) => {
				mockState.lastParams = params;
				const stream = {
					async *[Symbol.asyncIterator]() {
						yield {
							type: "response.output_item.added",
							item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
						};
						yield { type: "response.content_part.added", part: { type: "output_text", text: "" } };
						yield { type: "response.output_text.delta", delta: "Hello" };
						yield {
							type: "response.output_item.done",
							item: {
								type: "message",
								id: "msg_1",
								role: "assistant",
								status: "completed",
								content: [{ type: "output_text", text: "Hello" }],
							},
						};
						yield {
							type: "response.completed",
							response: {
								status: "completed",
								usage: {
									input_tokens: 5,
									output_tokens: 3,
									total_tokens: 8,
									input_tokens_details: { cached_tokens: 0 },
								},
							},
						};
					},
				};
				const promise = Promise.resolve(stream) as Promise<typeof stream> & {
					withResponse: () => Promise<{
						data: typeof stream;
						response: { status: number; headers: Headers };
					}>;
				};
				promise.withResponse = async () => ({
					data: stream,
					response: { status: 200, headers: new Headers() },
				});
				return promise;
			},
		};
	}

	return { default: FakeOpenAI };
});

describe("openai-responses service_tier handling", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	it("omits service_tier for github-copilot models", async () => {
		const model = getModel("github-copilot", "gpt-5.6-luna")!;

		await streamOpenAIResponses(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test", serviceTier: "default" },
		).result();

		const params = mockState.lastParams as Record<string, unknown>;
		expect("service_tier" in params).toBe(false);
	});

	it("still sends service_tier for openai models", async () => {
		const model = getModel("openai", "gpt-5")!;

		await streamOpenAIResponses(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test", serviceTier: "priority" },
		).result();

		const params = mockState.lastParams as { service_tier?: string };
		expect(params.service_tier).toBe("priority");
	});
});
