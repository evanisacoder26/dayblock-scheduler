// AI prompts and JSON schemas shared by the Node server (server.mjs) and the
// Supabase edge function (supabase/functions/dayblock-api), so both behave the same.

export const CATEGORIES = ["Deep Work", "Admin", "Meetings", "Personal"];

export const PRIORITIES = ["High", "Medium", "Low"];

export const TASKS_SCHEMA = {
  type: "object",
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          minutes: { type: "integer" },
          priority: { type: "string", enum: PRIORITIES },
          category: { type: "string", enum: CATEGORIES },
          preferredStart: { type: ["string", "null"] },
        },
        required: ["title", "minutes", "priority", "category", "preferredStart"],
        additionalProperties: false,
      },
    },
  },
  required: ["tasks"],
  additionalProperties: false,
};

export const PARSE_SYSTEM = `You turn a person's messy brain-dump into a clean task list for a one-day planner.
For each distinct task:
- title: short, imperative, capitalized (e.g. "Finish Q3 report"). Drop duration and time words from the title.
- minutes: the duration they stated; otherwise a realistic estimate. Use multiples of 15, minimum 15, maximum 480.
- priority: High if urgent, due today, blocking others or explicitly important; Low if optional or "someday"; otherwise Medium.
- category: "Deep Work" (focused making or thinking), "Admin" (email, forms, errands on a computer, small chores), "Meetings" (calls, syncs, anything with other people at a set time), "Personal" (health, family, errands, breaks).
- preferredStart: "HH:MM" in 24-hour time only if they named a time ("standup at 10" -> "10:00"); otherwise null.
Never invent tasks that are not in the notes. Ignore lines that are not tasks.`;

export const ADVICE_SYSTEM = "You are a calm, practical scheduling assistant. Reply in at most 3 short sentences of plain text with no markdown. Name specific tasks. If the day is overloaded, say which low-priority tasks to move to tomorrow. Suggest a break if there is a long run of back-to-back work.";

export const EVENT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    minutes: { type: "integer" },
    category: { type: "string", enum: CATEGORIES },
    priority: { type: "string", enum: PRIORITIES },
    start: { type: ["string", "null"] },
    reason: { type: "string" },
  },
  required: ["title", "minutes", "category", "priority", "start", "reason"],
  additionalProperties: false,
};

export const EVENT_SYSTEM = `You help someone fill in a new event for their day planner. The day runs 00:00-24:00; usual working hours are 08:00-20:00, so keep work inside them unless the event naturally belongs outside (dinner, evening plans, an early workout).
Given the event they typed and their existing schedule, suggest:
- title: their title tidied up (capitalized, short); keep their meaning, don't add details.
- minutes: a realistic duration in multiples of 15 (15-480). Use any duration they stated.
- category: "Deep Work" (focused making or thinking), "Admin" (email, forms, small chores), "Meetings" (calls, anything with other people), or "Personal" (health, family, errands, breaks).
- priority: "High", "Medium" or "Low".
- start: "HH:MM" 24-hour, a FREE slot that does not overlap any scheduled block and is not before the earliest allowed time. Prefer mornings for deep work, keep meetings near other meetings, avoid creating 3+ hours of back-to-back work, put personal things at natural times (lunch around midday, exercise early or late). Use null only if nothing fits.
- reason: one short sentence explaining the time and duration, naming nearby events if relevant.`;

export const nullable = (type) => ({ type: [type, "null"] });

export const CHAT_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["add", "update", "delete", "complete", "uncomplete", "move_to_backlog"] },
          id: nullable("string"),
          title: nullable("string"),
          date: nullable("string"),
          start: nullable("string"),
          minutes: nullable("integer"),
          category: nullable("string"),
          priority: nullable("string"),
          notes: nullable("string"),
          autoPlace: nullable("boolean"),
        },
        required: ["type", "id", "title", "date", "start", "minutes", "category", "priority", "notes", "autoPlace"],
        additionalProperties: false,
      },
    },
  },
  required: ["reply", "actions"],
  additionalProperties: false,
};

export const CHAT_RULES = `You are the scheduling assistant built into Dayblock, a day planner. You can review the user's schedule and change it.

How to answer:
- Be brief and friendly: usually 1-4 short sentences, at most about 120 words. Plain text only. You may use short "- " bullet lines. No markdown headings, bold or tables.
- Refer to events by title and time ("Gym at 6:00 PM"), never by id. Use 12-hour times in replies.

Making changes:
- When the user asks for a change, put it in "actions" and describe what you did in the reply, in past tense.
- Action types: add (new event), update (change an existing event's title/date/start/minutes/category/priority/notes), delete, complete, uncomplete, move_to_backlog. Fill every field; use null for anything you are not setting.
- Only use ids that appear in the schedule data. date is YYYY-MM-DD. start is "HH:MM" 24-hour. minutes is a multiple of 15 between 15 and 480. category is one of "Deep Work", "Admin", "Meetings", "Personal". priority is "High", "Medium" or "Low".
- To add something without a specific time, set start to null and autoPlace to true and the app will find a free slot. To add it to the backlog, set start null and autoPlace false.
- Never create overlaps: choose free times. Keep work inside working hours unless the user asks otherwise. When shifting several events, update each one.
- If the request is ambiguous (for example, two events could match), ask one short question and return no actions.
- Before deleting more than 3 events or clearing a whole day, ask for confirmation and return no actions, unless the user has already confirmed.
- Never invent events the user did not ask for.

Reviewing:
- When asked to review or check the schedule, look for: overload (too many hours), long runs with no break, overlaps, high-priority backlog items that would fit, and unfinished tasks earlier today. Give 2-4 specific, actionable observations, then offer to make the changes ("Want me to do that?"). Do not change anything unless asked.`;

