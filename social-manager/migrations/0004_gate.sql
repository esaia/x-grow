-- "Tap a button first" for comment auto-replies, optionally "follow first".
-- JSON: {"opener": "...", "button": "...", "follow": {"text": "...", "button": "..."} | null}.
-- NULL → the first DM is the link itself, as before.
ALTER TABLE rules ADD COLUMN gate TEXT;
