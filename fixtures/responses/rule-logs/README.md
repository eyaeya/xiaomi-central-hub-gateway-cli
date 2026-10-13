# Rule log contract samples

These are synthetic examples of the previously observed `/api/getLog` wire format,
registered during the 2026-10-13 reliability review. They are not new live captures.
`block.json` is a JSON string containing newline-delimited gateway rows;
`empty.json` is the explicit end-of-pages response. `invalid-response.json` is a
negative contract fixture: a structured response must raise `SchemaError`, never
be interpreted as an empty log or successful observation.
