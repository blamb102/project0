import * as cdk from 'aws-cdk-lib/core'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs'
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2'
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations'
import { Construct } from 'constructs'
import * as path from 'path'

const MEILI_MASTER_KEY = 'th-masterKey-2024'
const PG_PASSWORD      = 'th-pgPass-2024'

export class TelecomHubStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props)

    // ── Meilisearch on EC2 (t3.micro, Docker) ─────────────────────────────────

    const sg = new ec2.SecurityGroup(this, 'MeiliSG', {
      vpc: ec2.Vpc.fromLookup(this, 'DefaultVpc', { isDefault: true }),
      description: 'Meilisearch EC2',
    })
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(7700), 'Meilisearch HTTP')
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(5432), 'PostgreSQL')
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22),   'SSH (optional)')

    const userData = ec2.UserData.forLinux()
    userData.addCommands(
      'yum install -y docker',
      'systemctl enable --now docker',
      // Meilisearch
      `docker run -d --restart=always --name meilisearch \\`,
      `  -p 7700:7700 \\`,
      `  -e MEILI_MASTER_KEY=${MEILI_MASTER_KEY} \\`,
      `  -e MEILI_ENV=production \\`,
      `  -v /var/lib/meilisearch:/meili_data \\`,
      `  getmeili/meilisearch:v1.8`,
      // Postgres (body-text FTS) — named volume avoids host bind-mount permission issues
      `docker run -d --restart=always --name postgres \\`,
      `  -p 5432:5432 \\`,
      `  -e POSTGRES_USER=telecom \\`,
      `  -e POSTGRES_PASSWORD=${PG_PASSWORD} \\`,
      `  -e POSTGRES_DB=telecom_hub \\`,
      `  -v telecom_pg_data:/var/lib/postgresql/data \\`,
      `  postgres:16-alpine`,
      // Wait for Postgres then create the FTS table
      `for i in $(seq 1 30); do docker exec postgres pg_isready -U telecom && break; sleep 2; done`,
      `docker exec postgres psql -U telecom -d telecom_hub -c "` +
        `CREATE TABLE IF NOT EXISTS tdoc_fulltext (tdoc_id TEXT PRIMARY KEY, body_tsv TSVECTOR NOT NULL); ` +
        `CREATE INDEX IF NOT EXISTS tdoc_fts_idx ON tdoc_fulltext USING GIN (body_tsv);"`,
    )

    const ssmRole = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    })

    const meiliInstance = new ec2.Instance(this, 'MeiliInstance', {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      vpc: ec2.Vpc.fromLookup(this, 'DefaultVpc2', { isDefault: true }),
      securityGroup: sg,
      userData,
      role: ssmRole,
    })

    // Elastic IP so the address survives stop/start
    const eip = new ec2.CfnEIP(this, 'MeiliEIP', { instanceId: meiliInstance.instanceId })
    const meiliHost = eip.attrPublicIp

    // ── Lambda search proxy ───────────────────────────────────────────────────

    const searchFn = new NodejsFunction(this, 'SearchFn', {
      entry: path.join(__dirname, '../../services/search-api/index.ts'),
      projectRoot: path.join(__dirname, '../..'),
      depsLockFilePath: path.join(__dirname, '../../pnpm-lock.yaml'),
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(10),
      bundling: {
        externalModules: ['pg-native'],
        minify: false,
      },
      environment: {
        MEILISEARCH_URL:     `http://${meiliHost}:7700`,
        MEILISEARCH_MASTER_KEY: MEILI_MASTER_KEY,
        DATABASE_URL: `postgres://telecom:${PG_PASSWORD}@${meiliHost}:5432/telecom_hub?sslmode=disable`,
      },
    })

    const analystFn = new NodejsFunction(this, 'AnalystFn', {
      entry: path.join(__dirname, '../../services/analyst-api/index.ts'),
      projectRoot: path.join(__dirname, '../..'),
      depsLockFilePath: path.join(__dirname, '../../pnpm-lock.yaml'),
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(60),
      bundling: { minify: false },
      environment: {
        MEILISEARCH_URL:        `http://${meiliHost}:7700`,
        MEILISEARCH_MASTER_KEY: MEILI_MASTER_KEY,
        ANTHROPIC_API_KEY:      process.env.ANTHROPIC_API_KEY ?? '',
      },
    })

    const httpApi = new apigwv2.HttpApi(this, 'SearchApi', {
      defaultIntegration: new integrations.HttpLambdaIntegration('SearchInteg', searchFn),
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.OPTIONS],
      },
    })

    const analyzeApi = new apigwv2.HttpApi(this, 'AnalyzeApi', {
      defaultIntegration: new integrations.HttpLambdaIntegration('AnalyzeInteg', analystFn),
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.OPTIONS],
      },
    })

    // ── S3 + CloudFront for the search UI ────────────────────────────────────

    const uiBucket = new s3.Bucket(this, 'SearchUiBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    })

    const apiHostname     = `${httpApi.apiId}.execute-api.${this.region}.amazonaws.com`
    const analyzeHostname = `${analyzeApi.apiId}.execute-api.${this.region}.amazonaws.com`

    const distribution = new cloudfront.Distribution(this, 'SearchDistribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(uiBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      additionalBehaviors: {
        '/api/analyze': {
          origin: new origins.HttpOrigin(analyzeHostname, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          }),
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy:
            cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
        '/api/*': {
          origin: new origins.HttpOrigin(apiHostname, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          }),
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy:
            cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
      // SPA fallback
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
    })

    new s3deploy.BucketDeployment(this, 'SearchUiDeploy', {
      sources: [
        s3deploy.Source.asset(path.join(__dirname, '../../apps/3gpp-search/out')),
      ],
      destinationBucket: uiBucket,
      distribution,
      distributionPaths: ['/*'],
    })

    // ── Outputs ───────────────────────────────────────────────────────────────

    new cdk.CfnOutput(this, 'SearchUiUrl', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'Search UI (CloudFront)',
    })

    new cdk.CfnOutput(this, 'MeilisearchUrl', {
      value: `http://${meiliHost}:7700`,
      description: 'Meilisearch (run indexer with this URL)',
    })

    new cdk.CfnOutput(this, 'MeilisearchMasterKey', {
      value: MEILI_MASTER_KEY,
      description: 'Meilisearch master key for the indexer',
    })

    new cdk.CfnOutput(this, 'DatabaseUrl', {
      value: `postgres://telecom:${PG_PASSWORD}@${meiliHost}:5432/telecom_hub?sslmode=disable`,
      description: 'Postgres DATABASE_URL for the indexer --full-text flag',
    })
  }
}
