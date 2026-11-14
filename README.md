# Yes Chef

A shop sign you change by speaking. An agent turns each sentence into actions on the sign, the online menu and the till, but only after rules stored in MongoDB Atlas allow it. Every change records who asked, their exact words and the rule that permitted it.

Built on November 14, 2026 at Agents in Context Toronto, a MongoDB hackathon, for **Statement 1: Agents You Can Audit**.

> Work in progress. This README is updated at each milestone.

## What was built today

Everything in `src/`, `public/`, `scripts/` and `test/`.

## What is off the shelf

Cloudflare Workers and the Agents SDK, Workers AI models (Clairic for extraction, GLM-4.7-flash for planning), ElevenLabs (speech to text and text to speech), the MongoDB Node.js driver, and a vendored QR code generator.

## What is a mock

The sign, the online menu and the till are mock systems written today. Each is its own Atlas collection with apply, read-back and restore. The owner and employee are seeded identities.
