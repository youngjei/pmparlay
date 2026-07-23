# Market Repository Integration Tests

Run the real PostgreSQL concurrency and pinned-cursor tests against a disposable local database:

```sh
TEST_DATABASE_URL=postgres://localhost/legwork_test \
  npm test -- server/tests/marketRepository.integration.test.ts
```

The suite creates a uniquely named schema, applies only the core and market catalog migrations, and drops the schema after the run. It never uses `DATABASE_URL` as the test target.
