-- The operator dropped NOT NULL on memory_entries.ask in the live DB so
-- summary-only / "ask not captured" sessions can be stored without a prompt.
-- Version-controlled here so teammates and fresh installs match. Idempotent.
alter table public.memory_entries alter column ask drop not null;
