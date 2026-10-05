import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolRequest } from "../core/provider.js";
import { AnthropicProvider } from "./anthropic.js";
import { BedrockProvider } from "./bedrock.js";
import { OpenAIProvider } from "./openai.js";

const base: ToolRequest = {
  systemPrompt: "system",
  userPrompt: "user",
  tools: [{ name: "read_file", description: "Read a file", parameters: {
    type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false,
  } }],
  execute: async (name, args) => ({ content: `${name}:${args.path}` }),
};

test("OpenAI carries function-call output into the next response", async () => {
  const requests: unknown[] = [];
  const fake = { responses: { create: async (body: unknown) => {
    requests.push(body);
    return requests.length === 1
      ? { id: "response-1", output_text: "", output: [{ type: "function_call", call_id: "call-1", name: "read_file", arguments: '{"path":"note.txt"}' }] }
      : { id: "response-2", output_text: "done", output: [] };
  } } };
  const response = await new OpenAIProvider("model", fake as never).generateWithTools(base);
  assert.equal(response.text, "done");
  assert.equal(response.toolCalls, 1);
  assert.equal((requests[1] as { previous_response_id: string }).previous_response_id, "response-1");
  assert.match(JSON.stringify(requests[1]), /read_file:note.txt/);
});

test("Anthropic returns tool results with the matching tool_use ID", async () => {
  const requests: unknown[] = [];
  const fake = { messages: { create: async (body: unknown) => {
    requests.push(body);
    return requests.length === 1
      ? { content: [{ type: "tool_use", id: "tool-1", name: "read_file", input: { path: "note.txt" } }] }
      : { content: [{ type: "text", text: "done" }] };
  } } };
  const response = await new AnthropicProvider("model", fake as never).generateWithTools(base);
  assert.equal(response.text, "done");
  assert.equal(response.toolCalls, 1);
  assert.match(JSON.stringify(requests[1]), /tool_use_id":"tool-1"/);
});

test("Bedrock returns tool results with the matching toolUseId", async () => {
  const requests: unknown[] = [];
  const fake = { send: async (command: { input: unknown }) => {
    requests.push(command.input);
    return requests.length === 1
      ? { output: { message: { role: "assistant", content: [{ toolUse: { toolUseId: "tool-1", name: "read_file", input: { path: "note.txt" } } }] } } }
      : { output: { message: { role: "assistant", content: [{ text: "done" }] } } };
  } };
  const response = await new BedrockProvider("model", fake as never).generateWithTools(base);
  assert.equal(response.text, "done");
  assert.equal(response.toolCalls, 1);
  assert.match(JSON.stringify(requests[1]), /toolUseId":"tool-1"/);
});

test("all providers send Wren's screenshot as image input", async () => {
  const image = { mimeType: "image/png" as const, data: Buffer.from("picture").toString("base64") };
  const request = { systemPrompt: "review", userPrompt: "Inspect this page", images: [image] };
  let openaiInput: unknown;
  await new OpenAIProvider("model", { responses: { create: async (body: unknown) => { openaiInput = body; return { output_text: "seen" }; } } } as never).generate(request);
  assert.match(JSON.stringify(openaiInput), /input_image/);
  assert.match(JSON.stringify(openaiInput), /data:image\/png;base64/);
  let anthropicInput: unknown;
  await new AnthropicProvider("model", { messages: { create: async (body: unknown) => { anthropicInput = body; return { content: [{ type: "text", text: "seen" }] }; } } } as never).generate(request);
  assert.match(JSON.stringify(anthropicInput), /"type":"image"/);
  assert.match(JSON.stringify(anthropicInput), /"media_type":"image\/png"/);
  let bedrockInput: unknown;
  await new BedrockProvider("model", { send: async (command: { input: unknown }) => { bedrockInput = command.input; return { output: { message: { content: [{ text: "seen" }] } } }; } } as never).generate(request);
  assert.match(JSON.stringify(bedrockInput), /"image"/);
  assert.match(JSON.stringify(bedrockInput), /"format":"png"/);
});
