#!/bin/bash
# Creates the FIFO queues used by the service. The application also creates them idempotently
# on startup when SQS_CREATE_QUEUES=true, so this script is a convenience for manual inspection.
set -euo pipefail
awslocal sqs create-queue --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,MessageRetentionPeriod=1209600 >/dev/null
DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url http://localhost:4566/000000000000/wager-transactions-dlq.fifo \
  --attribute-names QueueArn --query Attributes.QueueArn --output text)
awslocal sqs create-queue --queue-name wager-transactions.fifo \
  --attributes "{\"FifoQueue\":\"true\",\"VisibilityTimeout\":\"30\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}" >/dev/null
awslocal sqs create-queue --queue-name wagering-events.fifo --attributes FifoQueue=true >/dev/null
echo "SQS queues ready"
