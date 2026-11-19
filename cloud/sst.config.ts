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
    const api = new sst.aws.ApiGatewayV2("DisplayApi");
    const tokenParameter = `/waypoint-terminal/${$app.stage}/device-token`;
    const feedSettings = `/waypoint-terminal/${$app.stage}/feed-settings`;
    const railKey = `/waypoint-terminal/${$app.stage}/rail-api-key`;
    const octopusKey = `/waypoint-terminal/${$app.stage}/octopus-api-key`;
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

    api.route("GET /v1/devices/waypoint/display", {
      handler: "src/display.handler",
      runtime: "nodejs22.x",
      environment: { SCENES_BUCKET: scenes.name },
      permissions: [
        { actions: ["s3:GetObject"], resources: [
          $interpolate`${scenes.arn}/scenes/waypoint.json`,
          $interpolate`${scenes.arn}/feeds/waypoint.json`,
        ] },
      ],
    }, { auth: { lambda: authorizer.id } });

    const collector = new sst.aws.Function("CollectFeeds", {
      handler: "src/collect.handler",
      runtime: "nodejs22.x",
      timeout: "25 seconds",
      environment: {
        SCENES_BUCKET: scenes.name,
        FEED_SETTINGS: feedSettings,
        RAIL_API_KEY: railKey,
        OCTOPUS_API_KEY: octopusKey,
      },
      permissions: [
        { actions: ["s3:GetObject", "s3:PutObject"], resources: [
          $interpolate`${scenes.arn}/feeds/waypoint.json`,
          $interpolate`${scenes.arn}/feeds/orbits.json`,
          $interpolate`${scenes.arn}/feeds/energy.json`,
        ] },
        { actions: ["ssm:GetParameters"], resources: [
          $interpolate`arn:aws:ssm:eu-west-1:${accountId}:parameter${feedSettings}`,
          $interpolate`arn:aws:ssm:eu-west-1:${accountId}:parameter${railKey}`,
          $interpolate`arn:aws:ssm:eu-west-1:${accountId}:parameter${octopusKey}`,
        ] },
      ],
    });
    new sst.aws.CronV2("RefreshFeeds", { function: collector, schedule: "rate(1 minute)" });

    return { apiUrl: api.url, scenesBucket: scenes.name, collectorName: collector.name };
  },
});
