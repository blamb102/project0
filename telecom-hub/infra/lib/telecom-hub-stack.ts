import * as cdk from 'aws-cdk-lib/core'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2'
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations'
import { Construct } from 'constructs'
import * as path from 'path'

// Master key is fine for testing; replace with a secret before production.
const MEILI_MASTER_KEY = 'th-masterKey-2024'

export class TelecomHubStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props)

    // ── Meilisearch on EC2 (t3.micro, Docker) ─────────────────────────────────

    const sg = new ec2.SecurityGroup(this, 'MeiliSG', {
      vpc: ec2.Vpc.fromLookup(this, 'DefaultVpc', { isDefault: true }),
      description: 'Meilisearch EC2',
    })
    // Allow Meilisearch from anywhere (key-protected). Restrict post-testing.
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(7700), 'Meilisearch HTTP')
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'SSH (optional)')

    const userData = ec2.UserData.forLinux()
    userData.addCommands(
      'yum install -y docker',
      'systemctl enable --now docker',
      `docker run -d --restart=always \\`,
      `  -p 7700:7700 \\`,
      `  -e MEILI_MASTER_KEY=${MEILI_MASTER_KEY} \\`,
      `  -e MEILI_ENV=production \\`,
      `  -v /var/lib/meilisearch:/meili_data \\`,
      `  getmeili/meilisearch:v1.8`,
    )

    const meiliInstance = new ec2.Instance(this, 'MeiliInstance', {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      vpc: ec2.Vpc.fromLookup(this, 'DefaultVpc2', { isDefault: true }),
      securityGroup: sg,
      userData,
    })

    // Elastic IP so the address survives stop/start
    const eip = new ec2.CfnEIP(this, 'MeiliEIP', { instanceId: meiliInstance.instanceId })
    const meiliHost = eip.attrPublicIp

    // ── Lambda search proxy ───────────────────────────────────────────────────

    const searchFn = new lambda.Function(this, 'SearchFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../services/search-api')),
      timeout: cdk.Duration.seconds(10),
      environment: {
        MEILISEARCH_URL: `http://${meiliHost}:7700`,
        MEILISEARCH_MASTER_KEY: MEILI_MASTER_KEY,
      },
    })

    const httpApi = new apigwv2.HttpApi(this, 'SearchApi', {
      defaultIntegration: new integrations.HttpLambdaIntegration('SearchInteg', searchFn),
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

    const apiHostname = `${httpApi.apiId}.execute-api.${this.region}.amazonaws.com`

    const distribution = new cloudfront.Distribution(this, 'SearchDistribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(uiBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      additionalBehaviors: {
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
  }
}
