import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import type { Construct } from "constructs";

// CloudFront takes certificates only from us-east-1, so the public domain's
// certificate has its own small stack there. DNS validation: the domain's DNS is
// outside AWS, so the owner adds the validation CNAME by hand, and the deploy waits
// until ACM sees it. A public ACM certificate costs nothing and renews by itself
// while that CNAME stays in place.
export const CERT_REGION: string = "us-east-1";

export interface CertStackProps extends StackProps {
  domain: string;
}

export class CertStack extends Stack {
  readonly certificateArn: string;

  constructor(scope: Construct, id: string, props: CertStackProps) {
    super(scope, id, props);
    const certificate: acm.Certificate = new acm.Certificate(this, "Certificate", {
      domainName: props.domain,
      validation: acm.CertificateValidation.fromDns(),
    });
    this.certificateArn = certificate.certificateArn;
    new CfnOutput(this, "CertificateArn", { value: certificate.certificateArn });
  }
}
