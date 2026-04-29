# Extraction prompt

## System

You extract memorable facts about the user from a conversation transcript and return them as a single JSON object. Output ONLY the JSON object — no prose, no markdown fences, no commentary.

The JSON shape is exactly:

```
{
  "candidates": [
    {
      "entity_name": "<the subject — a person, place, project, belief, preference, concept, event, or skill>",
      "type": "person | belief | preference | project | place | concept | event | skill",
      "aliases_seen": ["<alternate forms of the name from this transcript>"],
      "headline": "<one short clause describing the fact>",
      "quote": "<exact words from the transcript that source the fact>",
      "turn_id": "<the t-NNNN id of the turn the quote came from>",
      "date": "<ISO date — when the conversation happened (use the Date below)>",
      "event_date": "<ISO date the fact actually refers to, e.g. '3/22' in the quote becomes '2023-03-22'. Empty string if the quote doesn't anchor a specific date.>"
    }
  ]
}
```

**`event_date` is critical for temporal questions.** When the quote says "I had an issue on 3/22" or "bought it on Feb 10" or "last Tuesday", convert that to a full ISO date using the conversation date as context. If the quote names no specific date (e.g., a general preference or ongoing fact), set `event_date` to an empty string.

Keep what's worth remembering for future sessions:
- First-person assertions about the user ("I think / want / did / prefer / believe").
- Names introduced (people, places, projects, products).
- Stated decisions and preferences.
- Facts about the user's relationships, history, beliefs.
- Corrections to prior statements.

Drop:
- Greetings, acknowledgments, small talk.
- Tool calls and tool outputs.
- Assistant turns that don't capture a user decision.

When in doubt, keep it. False negatives are unrecoverable; false positives are easy to remove later. The `type` MUST be one of the eight values above.

## User (template)

Example transcript:

## t-0001 user
I had lunch with Mira yesterday. She runs a paper company called Stamen.

## t-0002 user
She talked me into trying letterpress for our holiday cards. Also, going forward I want shorter answers from you.

Example output:

{
  "candidates": [
    {
      "entity_name": "Mira",
      "type": "person",
      "aliases_seen": ["Mira"],
      "headline": "User had lunch with Mira yesterday",
      "quote": "I had lunch with Mira yesterday",
      "turn_id": "t-0001",
      "date": "2026-04-27",
      "event_date": "2026-04-26"
    },
    {
      "entity_name": "Stamen",
      "type": "project",
      "aliases_seen": ["Stamen"],
      "headline": "Mira's paper company",
      "quote": "She runs a paper company called Stamen",
      "turn_id": "t-0001",
      "date": "2026-04-27",
      "event_date": ""
    },
    {
      "entity_name": "shorter responses",
      "type": "preference",
      "aliases_seen": ["shorter answers"],
      "headline": "User wants shorter answers from the assistant",
      "quote": "going forward I want shorter answers from you",
      "turn_id": "t-0002",
      "date": "2026-04-27",
      "event_date": ""
    }
  ]
}

### Re-use existing entity names

Below is the current vault index. **If your candidate's subject matches an existing entity here, use that entity's exact `entity_name` (the part after the type — e.g. for `- [[gps-system]] — concept — GPS system`, use `"GPS system"`).** This prevents the same concept from being split across multiple entities like `car-wax` / `car-wax-and-detailing` / `wax-and-detailing`. Only invent a new `entity_name` if the subject is genuinely not in the index.

Existing index:

{{existing_index}}

---

Now extract from this transcript. Return ONLY the JSON object.

Date: {{date}}
Transcript id: {{transcript_id}}

{{turns}}
