import { Aws, CfnOutput, Duration, Fn, RemovalPolicy, Stack, Tags, type StackProps } from "aws-cdk-lib";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as ssm from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import { userDataText } from "./user-data.js";

export const REGION: string = "ap-southeast-1";
// GitHub signs this repo's OIDC tokens with immutable subject claims: the owner and
// the repo by name and numeric id (repos/jagnani73/payonce/actions/oidc/customization/sub).
// A repo deleted and created again under the same name gets a new id, so it cannot deploy.
const GITHUB_SUBJECT: string = "repo:jagnani73@60016972/payonce@1406848989";
const DEPLOY_DOCUMENT: string = "PayOnce-Deploy";
const UBUNTU_AMI: string = "/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id";
const CLOUDFRONT_ORIGIN_FACING: string = "com.amazonaws.global.cloudfront.origin-facing";
// Tags for what CloudFormation does not tag from the stack: the launch template
// and the disk and network interface the instance starts with.
const TAGS: { key: string; value: string }[] = [
  { key: "project", value: "payonce" },
  { key: "Name", value: "payonce" },
];

export interface PayOnceStackProps extends StackProps {
  // Where both budgets send their emails. Given at deploy time, never committed.
  alertEmail: string;
}

// PayOnce on one EC2 instance behind CloudFront, its release bucket, the deploy
// role GitHub Actions assumes, and two budgets that stop the instance. Everything
// is in this one stack, with no bootstrap stack, no asset and no Lambda.
export class PayOnceStack extends Stack {
  constructor(scope: Construct, id: string, props: PayOnceStackProps) {
    super(scope, id, props);

    const vpc: ec2.Vpc = new ec2.Vpc(this, "Vpc", {
      ipAddresses: ec2.IpAddresses.cidr("10.73.0.0/24"),
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 26, mapPublicIpOnLaunch: false },
      ],
      restrictDefaultSecurityGroup: false,
    });
    const subnet: ec2.ISubnet = vpc.publicSubnets[0]!;

    const cloudFront: ec2.IPrefixList = ec2.PrefixList.fromLookup(this, "CloudFrontOrigins", {
      prefixListName: CLOUDFRONT_ORIGIN_FACING,
    });
    const firewall: ec2.SecurityGroup = new ec2.SecurityGroup(this, "Firewall", {
      vpc,
      description: "PayOnce: HTTP from CloudFront only",
      allowAllOutbound: true,
    });
    firewall.addIngressRule(ec2.Peer.prefixList(cloudFront.prefixListId), ec2.Port.tcp(80), "CloudFront origin-facing");

    // Empty it before cdk destroy: CloudFormation cannot delete a bucket with objects.
    const releases: s3.Bucket = new s3.Bucket(this, "Releases", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      lifecycleRules: [{ expiration: Duration.days(7), abortIncompleteMultipartUploadAfter: Duration.days(1) }],
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const releaseObjects: string = releases.arnForObjects("releases/*");

    const serverRole: iam.Role = new iam.Role(this, "ServerRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      description: "PayOnce instance: SSM, its release tarballs and its own parameters",
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")],
      inlinePolicies: {
        payonce: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({ actions: ["s3:GetObject"], resources: [releaseObjects] }),
            // The managed policy reads every parameter. PayOnce reads only its own.
            new iam.PolicyStatement({
              effect: iam.Effect.DENY,
              actions: ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath", "ssm:GetParameterHistory"],
              notResources: [`arn:aws:ssm:${REGION}:${Aws.ACCOUNT_ID}:parameter/payonce/*`],
            }),
          ],
        }),
      },
    });
    const profile: iam.CfnInstanceProfile = new iam.CfnInstanceProfile(this, "ServerProfile", {
      roles: [serverRole.roleName],
    });

    const image: ec2.MachineImageConfig = ec2.MachineImage.fromSsmParameter(UBUNTU_AMI, {
      os: ec2.OperatingSystemType.LINUX,
      cachedInContext: true,
    }).getImage(this);
    const template: ec2.CfnLaunchTemplate = new ec2.CfnLaunchTemplate(this, "ServerTemplate", {
      launchTemplateData: {
        imageId: image.imageId,
        instanceType: "t4g.small",
        iamInstanceProfile: { arn: profile.attrArn },
        securityGroupIds: [firewall.securityGroupId],
        monitoring: { enabled: false },
        // Standard credits: a busy CPU slows down instead of costing extra.
        creditSpecification: { cpuCredits: "standard" },
        metadataOptions: { httpTokens: "required", httpEndpoint: "enabled", httpPutResponseHopLimit: 1 },
        blockDeviceMappings: [
          {
            deviceName: "/dev/sda1",
            ebs: { volumeSize: 10, volumeType: "gp3", encrypted: true, deleteOnTermination: true },
          },
        ],
        userData: Fn.base64(userDataText(`RELEASE_BUCKET=${releases.bucketName}\nAWS_REGION=${REGION}\n`)),
        tagSpecifications: ["volume", "network-interface"].map((resourceType: string) => ({ resourceType, tags: TAGS })),
      },
      tagSpecifications: [{ resourceType: "launch-template", tags: TAGS }],
    });
    // A new launch template version replaces the instance, so a changed user data
    // runs on a fresh one.
    const server: ec2.CfnInstance = new ec2.CfnInstance(this, "Server", {
      launchTemplate: { launchTemplateId: template.ref, version: template.attrLatestVersionNumber },
      subnetId: subnet.subnetId,
    });
    server.node.addDependency(subnet.internetConnectivityEstablished);
    Tags.of(server).add("Name", "payonce");
    const serverArn: string = `arn:aws:ec2:${REGION}:${Aws.ACCOUNT_ID}:instance/${server.ref}`;

    const address: ec2.CfnEIP = new ec2.CfnEIP(this, "Address", { domain: "vpc" });
    Tags.of(address).add("Name", "payonce");
    new ec2.CfnEIPAssociation(this, "AddressLink", { allocationId: address.attrAllocationId, instanceId: server.ref });

    // CloudFront needs a name for its origin, and every EC2 public address has one.
    const originHost: string = Fn.join("", [
      "ec2-",
      Fn.join("-", Fn.split(".", address.ref)),
      `.${REGION}.compute.amazonaws.com`,
    ]);
    // The header nginx requires, made of ids only this account can read: the
    // stack's id and the Elastic IP's allocation id.
    const originSecret: string = Fn.join("-", [
      Fn.select(2, Fn.split("/", Aws.STACK_ID)),
      Fn.select(1, Fn.split("-", address.attrAllocationId)),
    ]);
    // Nothing is cached: the page's files keep their names across releases and the
    // server sends them no-store.
    const cdn: cloudfront.Distribution = new cloudfront.Distribution(this, "Cdn", {
      comment: "PayOnce",
      defaultBehavior: {
        origin: new origins.HttpOrigin(originHost, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          httpPort: 80,
          readTimeout: Duration.seconds(60),
          customHeaders: { "X-Origin-Verify": originSecret },
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_AND_CLOUDFRONT_2022,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
      },
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
    });

    // Read by payonce-env on the instance. Parameters, not user data, so the
    // instance does not wait on the distribution.
    new ssm.StringParameter(this, "PublicDomain", {
      parameterName: "/payonce/cloudfront-domain",
      stringValue: cdn.distributionDomainName,
    });
    new ssm.StringParameter(this, "OriginHeader", {
      parameterName: "/payonce/origin-header",
      stringValue: originSecret,
    });

    const deployDocument: ssm.CfnDocument = new ssm.CfnDocument(this, "DeployDocument", {
      name: DEPLOY_DOCUMENT,
      documentType: "Command",
      updateMethod: "NewVersion",
      content: {
        schemaVersion: "2.2",
        description: "Deploy one PayOnce release by its commit",
        parameters: {
          sha: { type: "String", description: "The release's 40-character commit SHA", allowedPattern: "^[0-9a-f]{40}$" },
        },
        mainSteps: [
          {
            action: "aws:runShellScript",
            name: "deploy",
            inputs: { timeoutSeconds: "900", runCommand: ["/usr/local/sbin/payonce-deploy {{ sha }}"] },
          },
        ],
      },
    });

    const github: iam.OidcProviderNative = new iam.OidcProviderNative(this, "GitHub", {
      url: "https://token.actions.githubusercontent.com",
      clientIds: ["sts.amazonaws.com"],
    });
    const deployRole: iam.Role = new iam.Role(this, "DeployRole", {
      assumedBy: new iam.WebIdentityPrincipal(github.oidcProviderArn, {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": `${GITHUB_SUBJECT}:ref:refs/heads/main`,
        },
      }),
      description: "GitHub Actions on main: upload a release and run PayOnce-Deploy",
      maxSessionDuration: Duration.hours(1),
      inlinePolicies: {
        deploy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({ actions: ["s3:PutObject"], resources: [releaseObjects] }),
            new iam.PolicyStatement({
              actions: ["ssm:SendCommand"],
              resources: [serverArn, `arn:aws:ssm:${REGION}:${Aws.ACCOUNT_ID}:document/${deployDocument.ref}`],
            }),
            new iam.PolicyStatement({
              actions: ["ssm:GetCommandInvocation", "ssm:ListCommandInvocations", "ssm:ListCommands"],
              resources: ["*"],
            }),
          ],
        }),
      },
    });

    // Budgets stop the instance through SSM's AWS-StopEC2Instance automation.
    const calledViaSsm: Record<string, unknown> = { "ForAnyValue:StringEquals": { "aws:CalledVia": ["ssm.amazonaws.com"] } };
    const budgetRole: iam.Role = new iam.Role(this, "BudgetActionRole", {
      assumedBy: new iam.ServicePrincipal("budgets.amazonaws.com", {
        conditions: { StringEquals: { "aws:SourceAccount": Aws.ACCOUNT_ID } },
      }),
      description: "AWS Budgets: stop the PayOnce instance",
      inlinePolicies: {
        stop: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({ actions: ["ec2:StopInstances"], resources: [serverArn], conditions: calledViaSsm }),
            new iam.PolicyStatement({ actions: ["ec2:DescribeInstanceStatus"], resources: ["*"], conditions: calledViaSsm }),
            new iam.PolicyStatement({
              actions: ["ssm:StartAutomationExecution"],
              resources: [
                `arn:aws:ssm:${REGION}:*:document/AWS-StopEC2Instance`,
                `arn:aws:ssm:${REGION}:*:automation-definition/AWS-StopEC2Instance:*`,
                `arn:aws:ssm:${REGION}:${Aws.ACCOUNT_ID}:automation-execution/*`,
              ],
            }),
          ],
        }),
      },
    });
    const emails: budgets.CfnBudget.SubscriberProperty[] = [{ subscriptionType: "EMAIL", address: props.alertEmail }];
    const over = (type: string, threshold: number): budgets.CfnBudget.NotificationWithSubscribersProperty => ({
      notification: { notificationType: type, comparisonOperator: "GREATER_THAN", threshold, thresholdType: "ABSOLUTE_VALUE" },
      subscribers: emails,
    });
    const limits: { id: string; name: string; usd: number; includeCredit: boolean; notify: budgets.CfnBudget.NotificationWithSubscribersProperty[] }[] = [
      // What the account uses before credits. A normal month is about $20, so the
      // forecast email is set above it.
      { id: "GrossBudget", name: "payonce-gross-usage", usd: 30, includeCredit: false, notify: [over("FORECASTED", 25), over("ACTUAL", 30)] },
      // What is left after credits: real money.
      { id: "NetBudget", name: "payonce-real-money", usd: 1, includeCredit: true, notify: [over("ACTUAL", 1)] },
    ];
    for (const limit of limits) {
      const budget: budgets.CfnBudget = new budgets.CfnBudget(this, limit.id, {
        budget: {
          budgetName: limit.name,
          budgetType: "COST",
          timeUnit: "MONTHLY",
          budgetLimit: { amount: limit.usd, unit: "USD" },
          costTypes: { includeCredit: limit.includeCredit },
        },
        notificationsWithSubscribers: limit.notify,
        resourceTags: [{ key: "project", value: "payonce" }],
      });
      new budgets.CfnBudgetsAction(this, `${limit.id}Stop`, {
        budgetName: budget.ref,
        actionType: "RUN_SSM_DOCUMENTS",
        actionThreshold: { type: "ABSOLUTE_VALUE", value: limit.usd },
        notificationType: "ACTUAL",
        approvalModel: "AUTOMATIC",
        executionRoleArn: budgetRole.roleArn,
        definition: { ssmActionDefinition: { subtype: "STOP_EC2_INSTANCES", region: REGION, instanceIds: [server.ref] } },
        subscribers: [{ type: "EMAIL", address: props.alertEmail }],
      });
    }

    new CfnOutput(this, "Url", { value: `https://${cdn.distributionDomainName}` });
    new CfnOutput(this, "InstanceId", { value: server.ref });
    new CfnOutput(this, "ReleaseBucket", { value: releases.bucketName });
    new CfnOutput(this, "DeployRoleArn", { value: deployRole.roleArn });
  }
}
