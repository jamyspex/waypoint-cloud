/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app() {
    return {
      name: "waypoint-terminal",
      home: "aws",
      removal: "retain",
      providers: { aws: { region: "eu-west-1" } },
    };
  },
  async run() {
    const scenes = new sst.aws.Bucket("Scenes");
    // Rail Data Marketplace delivers file products (such as the NWR schedule) into this bucket
    // using the access key of a dedicated IAM user, which can only reach this bucket.
    const railFilesUser = new aws.iam.User("RailFilesUser", { name: `waypoint-terminal-${$app.stage}-rdm-file-transfer` });
    // The bucket policy RDM asks for, granting the same user the access its IAM policy has.
    const rdm = [{ type: "aws" as const, identifiers: [railFilesUser.arn] }];
    // RDM's file transfer has no region setting and only reaches buckets in London (eu-west-2).
    const london = new aws.Provider("London", { region: "eu-west-2" });
    const railFiles = new sst.aws.Bucket("RailFilesLondon", {
      policy: [
        { principals: rdm, actions: ["s3:GetObject", "s3:PutObject"], paths: ["*"] },
        { principals: rdm, actions: ["s3:GetBucketLocation"], paths: [""] },
        {
          principals: rdm, actions: ["s3:ListBucket"], paths: [""],
          conditions: [
            { test: "StringEquals", variable: "s3:prefix", values: [""] },
            { test: "StringEquals", variable: "s3:delimiter", values: ["/"] },
          ],
        },
      ],
    }, { provider: london });
    // Server access logs record every request RDM makes, including refused ones, for troubleshooting.
    const railFilesLogs = new aws.s3.BucketV2("RailFilesLogs", { forceDestroy: true }, { provider: london });
    new aws.s3.BucketPolicy("RailFilesLogsPolicy", {
      bucket: railFilesLogs.id,
      policy: $jsonStringify({
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow", Principal: { Service: "logging.s3.amazonaws.com" }, Action: "s3:PutObject",
          Resource: $interpolate`${railFilesLogs.arn}/*`,
          Condition: { StringEquals: { "aws:SourceAccount": aws.getCallerIdentityOutput().accountId } },
        }],
      }),
    }, { provider: london });
    new aws.s3.BucketLoggingV2("RailFilesLogging", {
      bucket: railFiles.name, targetBucket: railFilesLogs.id, targetPrefix: "access/",
    }, { provider: london });
    new aws.iam.UserPolicy("RailFilesUserPolicy", {
      user: railFilesUser.name,
      policy: $jsonStringify({
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Action: ["s3:ListBucket", "s3:GetObject", "s3:PutObject", "s3:GetBucketLocation"],
          Resource: [railFiles.arn, $interpolate`${railFiles.arn}/*`],
        }],
      }),
    });
    const api = new sst.aws.ApiGatewayV2("DisplayApi");
    const tokenParameter = `/waypoint-terminal/${$app.stage}/device-token`;
    const feedSettings = `/waypoint-terminal/${$app.stage}/feed-settings`;
    const railKey = `/waypoint-terminal/${$app.stage}/rail-api-key`;
    const octopusKey = `/waypoint-terminal/${$app.stage}/octopus-api-key`;
    const calendarPrefix = `/waypoint-terminal/${$app.stage}/calendar`;
    const accountId = aws.getCallerIdentityOutput().accountId;
    const authorizer = api.addAuthorizer({
      name: "SharedDeviceCredential",
      lambda: {
        function: {
          handler: "src/authorize.handler",
          runtime: "nodejs22.x",
          environment: { TOKEN_PARAMETER: tokenParameter },
          permissions: [{
            actions: ["ssm:GetParameter"],
            resources: [$interpolate`arn:aws:ssm:eu-west-1:${accountId}:parameter${tokenParameter}`],
          }],
        },
        identitySources: ["$request.header.Authorization"],
        payload: "2.0",
        response: "simple",
        ttl: "30 seconds",
      },
    });

    // Home page and privacy policy required by the Google OAuth consent screen for production publishing.
    const site = { handler: "src/site.handler", runtime: "nodejs22.x" as const, memory: "128 MB" as const };
    api.route("GET /", site);
    api.route("GET /privacy", site);
    api.route("GET /v1/devices/waypoint/display", {
      handler: "src/display.handler",
      runtime: "nodejs22.x",
      environment: { SCENES_BUCKET: scenes.name },
      permissions: [
        { actions: ["s3:GetObject"], resources: [
          $interpolate`${scenes.arn}/scenes/waypoint.json`,
          $interpolate`${scenes.arn}/feeds/waypoint.json`,
          $interpolate`${scenes.arn}/feeds/waypoint-detailed.json`,
        ] },
      ],
    }, { auth: { lambda: authorizer.id } });

    // Flightradar24 lookups (flights, airports, airlines) and the daily credit budget.
    const fr24Cache = new sst.aws.Dynamo("Fr24Cache", {
      fields: { key: "string" },
      primaryIndex: { hashKey: "key" },
      ttl: "expireAt",
    });
    const fr24Token = `/waypoint-terminal/${$app.stage}/fr24-api-token`;
    // "Did you know" facts researched with Gemini + Google Search grounding, cached per subject.
    const contextTable = new sst.aws.Dynamo("ContextFacts", {
      fields: { subject: "string" },
      primaryIndex: { hashKey: "subject" },
      ttl: "expireAt",
    });
    // What passed by, for the overnight highlights: aircraft, vessels, satellites and aurora alerts (one row each
    // per London day) and every local freight train report. Kept for 180 days.
    const sightings = new sst.aws.Dynamo("Sightings", {
      fields: { day: "string", sk: "string", subject: "string" },
      primaryIndex: { hashKey: "day", rangeKey: "sk" },
      globalIndexes: { bySubject: { hashKey: "subject", rangeKey: "sk" } },
      ttl: "expireAt",
    });
    const geminiKey = `/waypoint-terminal/${$app.stage}/gemini-api-key`;
    const collector = new sst.aws.Function("CollectFeeds", {
      handler: "src/collect.handler",
      runtime: "nodejs22.x",
      timeout: "25 seconds",
      environment: {
        SCENES_BUCKET: scenes.name,
        FEED_SETTINGS: feedSettings,
        RAIL_API_KEY: railKey,
        OCTOPUS_API_KEY: octopusKey,
        CALENDAR_PREFIX: calendarPrefix,
        FR24_API_TOKEN: fr24Token,
        FR24_CACHE_TABLE: fr24Cache.name,
        CONTEXT_TABLE: contextTable.name,
        SIGHTINGS_TABLE: sightings.name,
      },
      permissions: [
        { actions: ["s3:GetObject", "s3:PutObject"], resources: [
          $interpolate`${scenes.arn}/feeds/waypoint.json`,
          $interpolate`${scenes.arn}/feeds/waypoint-detailed.json`,
          $interpolate`${scenes.arn}/feeds/orbits.json`,
          $interpolate`${scenes.arn}/feeds/energy.json`,
          $interpolate`${scenes.arn}/feeds/tides.json`,
          $interpolate`${scenes.arn}/feeds/freight-trains.json`,
          $interpolate`${scenes.arn}/feeds/air-fallback`,
        ] },
        { actions: ["ssm:GetParameters"], resources: [
          $interpolate`arn:aws:ssm:eu-west-1:${accountId}:parameter${feedSettings}`,
          $interpolate`arn:aws:ssm:eu-west-1:${accountId}:parameter${railKey}`,
          $interpolate`arn:aws:ssm:eu-west-1:${accountId}:parameter${octopusKey}`,
          $interpolate`arn:aws:ssm:eu-west-1:${accountId}:parameter${fr24Token}`,
        ] },
        { actions: ["dynamodb:BatchGetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"], resources: [fr24Cache.arn, contextTable.arn] },
        { actions: ["dynamodb:UpdateItem"], resources: [sightings.arn] },
        { actions: ["ce:GetCostAndUsage"], resources: ["*"] },
        { actions: ["ssm:GetParameter"], resources: [
          $interpolate`arn:aws:ssm:eu-west-1:${accountId}:parameter${calendarPrefix}/client`,
          $interpolate`arn:aws:ssm:eu-west-1:${accountId}:parameter${calendarPrefix}/settings`,
        ] },
        { actions: ["ssm:GetParametersByPath"], resources: [
          $interpolate`arn:aws:ssm:eu-west-1:${accountId}:parameter${calendarPrefix}/accounts`,
          $interpolate`arn:aws:ssm:eu-west-1:${accountId}:parameter${calendarPrefix}/accounts/*`,
        ] },
      ],
    });
    new sst.aws.CronV2("RefreshFeeds", { function: collector, schedule: "rate(1 minute)" });

    // Satellite catalogue: CelesTrak updates every two hours and serves each group once per update,
    // and the full Starlink list is too slow to download inside the one-minute collector.
    const orbitRefresher = new sst.aws.Function("RefreshOrbits", {
      handler: "src/orbits.handler",
      runtime: "nodejs22.x",
      timeout: "90 seconds",
      memory: "512 MB",
      environment: { SCENES_BUCKET: scenes.name, FEED_SETTINGS: feedSettings },
      permissions: [
        { actions: ["s3:GetObject", "s3:PutObject"], resources: [$interpolate`${scenes.arn}/feeds/orbits.json`] },
        { actions: ["ssm:GetParameter"], resources: [$interpolate`arn:aws:ssm:eu-west-1:${accountId}:parameter${feedSettings}`] },
      ],
    });
    new sst.aws.CronV2("RefreshOrbitsSchedule", { function: orbitRefresher, schedule: "rate(2 hours)" });

    // Researches queued "did you know" subjects; one copy at a time, capped per day and per month.
    const contextResearcher = new sst.aws.Function("ContextResearch", {
      handler: "src/context-facts.handler",
      runtime: "nodejs22.x",
      timeout: "5 minutes",
      memory: "256 MB",
      concurrency: { reserved: 1 },
      environment: { CONTEXT_TABLE: contextTable.name, GEMINI_API_KEY: geminiKey, GEMINI_MODEL: "gemini-4-hydrogen" },
      permissions: [
        { actions: ["dynamodb:Scan", "dynamodb:UpdateItem"], resources: [contextTable.arn] },
        { actions: ["ssm:GetParameter"], resources: [$interpolate`arn:aws:ssm:eu-west-1:${accountId}:parameter${geminiKey}`] },
      ],
    });
    new sst.aws.CronV2("ContextResearchSchedule", { function: contextResearcher, schedule: "rate(2 minutes)" });

    // Overnight highlights (21:00-07:00), built at 07:00 London time and shown from 08:00 to 12:00. The cron
    // runs at 06:00 and 07:00 UTC so 07:00 London is covered in both GMT and BST; the Lambda checks the hour.
    const overnightDigest = new sst.aws.Function("OvernightDigest", {
      handler: "src/overnight.handler",
      runtime: "nodejs22.x",
      timeout: "90 seconds",
      environment: {
        SIGHTINGS_TABLE: sightings.name, CONTEXT_TABLE: contextTable.name, FEED_SETTINGS: feedSettings,
        GEMINI_API_KEY: geminiKey, GEMINI_MODEL: "gemini-4-hydrogen",
      },
      permissions: [
        { actions: ["dynamodb:Query"], resources: [sightings.arn] },
        { actions: ["dynamodb:BatchGetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"], resources: [contextTable.arn] },
        { actions: ["ssm:GetParameter"], resources: [
          $interpolate`arn:aws:ssm:eu-west-1:${accountId}:parameter${geminiKey}`,
          $interpolate`arn:aws:ssm:eu-west-1:${accountId}:parameter${feedSettings}`,
        ] },
      ],
    });
    new sst.aws.CronV2("OvernightDigestSchedule", { function: overnightDigest, schedule: "cron(0 6,7 * * ? *)" });

    // Freight: AWS reads RDM's NWR Train Movements Kafka topic and hands batches to this Lambda,
    // which keeps the latest position of every freight train in feeds/freight-trains.json.
    const trainMovements = aws.secretsmanager.getSecretOutput({ name: `waypoint-terminal/${$app.stage}/rdm-train-movements` });
    // Learned freight routes: runs per (headcode#origin, terminus), expiring after 60 days unused.
    const freightRoutes = new sst.aws.Dynamo("FreightRoutes", {
      fields: { route: "string", terminus: "string" },
      primaryIndex: { hashKey: "route", rangeKey: "terminus" },
      ttl: "expireAt",
    });
    const freight = new sst.aws.Function("FreightMovements", {
      handler: "src/freight.handler",
      runtime: "nodejs22.x",
      timeout: "60 seconds",
      memory: "512 MB",
      concurrency: { reserved: 1 },
      environment: { SCENES_BUCKET: scenes.name, ROUTES_TABLE: freightRoutes.name, SIGHTINGS_TABLE: sightings.name },
      permissions: [
        { actions: ["s3:GetObject", "s3:PutObject"], resources: [$interpolate`${scenes.arn}/feeds/freight-trains.json`] },
        { actions: ["dynamodb:Query", "dynamodb:UpdateItem"], resources: [freightRoutes.arn] },
        { actions: ["dynamodb:BatchWriteItem"], resources: [sightings.arn] },
        { actions: ["secretsmanager:GetSecretValue"], resources: [trainMovements.arn] },
      ],
    });
    new aws.lambda.EventSourceMapping("FreightMovementsSource", {
      functionName: freight.name,
      topics: ["TRAIN_MVT_ALL_TOC"],
      startingPosition: "LATEST",
      batchSize: 10000,
      maximumBatchingWindowInSeconds: 60,
      selfManagedEventSource: { endpoints: { KAFKA_BOOTSTRAP_SERVERS: "pkc-z3p1v0.europe-west2.gcp.confluent.cloud:9092" } },
      selfManagedKafkaEventSourceConfig: { consumerGroupId: "SC-8aad6a4a-c640-482d-a8d1-19621fab5d8e" },
      sourceAccessConfigurations: [{ type: "BASIC_AUTH", uri: trainMovements.arn }],
    });

    return {
      apiUrl: api.url, scenesBucket: scenes.name, collectorName: collector.name,
      railFilesBucket: railFiles.name, railFilesUser: railFilesUser.name,
    };
  },
});
