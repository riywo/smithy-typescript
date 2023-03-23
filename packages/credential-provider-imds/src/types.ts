import { AwsCredentialIdentity } from "@smithy-io/types";

export interface InstanceMetadataCredentials extends AwsCredentialIdentity {
  readonly originalExpiration?: Date;
}
