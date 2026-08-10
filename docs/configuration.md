# Configuration

Every setting, what it defaults to, and why.

## Configuration

`~/.cloi/config.json` (override the location with `CLOI_DATA_DIR`):

```json
{
  "model": "qwen3:8b",
  "host": "http://127.0.0.1:11434",

  "maxIterations": 40,
  "maxStrikes": 3,
  "doomLoopThreshold": 3,
  "maxConsecutiveToolErrors": 3,

  "escalationModel": null,
  "maxEscalations": 1,

  "verifyAnswers": true,
  "maxVerificationRetries": 1,
  "judgeAnswers": null,
  "judgeModel": null,

  "temperature": 0.2,
  "think": null,
  "contextLength": 16384,
  "compaction": true,
  "compactionReserveTokens": 2048,
  "showUsage": true,
  "autoApprove": []
}
```

`think` is off by default: on local hardware a visible reasoning pass costs a
great deal of latency and buys little accuracy for tool selection. Turning it
off took one measured task from ~106 s to ~16 tok/s sustained.

Keep `maxVerificationRetries` low. A model that fails the same complaint twice
will fail it five times — measured, not assumed.
