// Default the singleton logger to silent during tests. Override with
// `LOG_LEVEL=debug npm test` when triaging a flaky run.
process.env.LOG_LEVEL ??= 'silent';
