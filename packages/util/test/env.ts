import { describe, it } from 'mocha';
import { expect } from 'chai';
import * as tmp from 'tmp-promise';
import { promises as fs } from 'fs';

// do this before the import since the env module clones process.env on import
const prevProcessEnv = process.env;
process.env.CLIENT_ID = 'client-007';
process.env.AWS_DEFAULT_REGION = 'us-east-3';
import { HarmonyEnv, getValidationErrors } from '../env';
import { IsInt } from 'class-validator';

describe('HarmonyEnv', function () {

  after(function () {
    process.env = prevProcessEnv;
  });

  describe('When the environment is valid', function () {
    before(async function () {
      this.dotEnvFile = await tmp.file();
      const envContent = 'DATABASE_TYPE=cassandra\nAWS_DEFAULT_REGION=us-west-0';
      await fs.writeFile(this.dotEnvFile.path, envContent, 'utf8');
      this.validEnv = new HarmonyEnv(undefined, this.dotEnvFile.path);
    });
    after(async function () {
      await this.dotEnvFile.cleanup();
    });

    it('does not throw an error when validated', function () {
      expect(() => this.validEnv.validate()).not.to.Throw;
    });

    it('does not log any errors', function () {
      expect(getValidationErrors(this.validEnv).length).to.eql(0);
    });

    it('sets special values (values that are set manually) using env-defaults', function () {
      expect(this.validEnv.useServiceQueues).to.eql(true);
    });

    it('sets non-special values using env-defaults', function () {
      expect(this.validEnv.localstackHost).to.eql('localstack');
    });

    it('converts non-string types', function () {
      expect(this.validEnv.defaultResultPageSize).to.eql(2000);
    });

    it('parses booleans from text', function () {
      expect(this.validEnv.textLogger).to.eql(true);
    });

    it('overrides util env-defaults with values read from process.env', function () {
      expect(this.validEnv.clientId).to.eql('client-007');
    });

    it('overrides util env-defaults with .env file values', function () {
      expect(this.validEnv.databaseType).to.eql('cassandra');
    });

    it('prefers process.env over .env', function () {
      expect(this.validEnv.awsDefaultRegion).to.eql('us-east-3');
    });

    it('sets service queue urls', function () {
      expect(this.validEnv.serviceQueueUrls['harmonyservices/service-example:latest'])
        .to.eql('http://sqs.us-west-2.localhost.localstack.cloud:4566/000000000000/harmony-service-example.fifo');
    });
  });

  describe('When the environment is invalid', function () {

    before(function () {
      this.invalidEnv = new HarmonyEnv();
      this.invalidEnv.port = -1;
      this.invalidEnv.callbackUrlRoot = 'foo';
    });

    it('throws an error when validated', function () {
      expect(() => this.invalidEnv.validate()).to.throw;
    });

    it('logs two errors', function () {
      expect(getValidationErrors(this.invalidEnv)).to.eql([
        {
          'children': [],
          'constraints': {
            'isUrl': 'callbackUrlRoot must be a URL address',
          },
          'property': 'callbackUrlRoot',
          'value': 'foo',
        },
        {
          'children': [],
          'constraints': {
            'min': 'port must not be less than 0',
          },
          'property': 'port',
          'value': -1,
        },
      ]);
    });
  });

  describe('When the environment is set via a HarmonyEnv subclass', function () {
    before(async function () {
      class HarmonyEnvSubclass extends HarmonyEnv {

        throttleDelay: number;

        throttleType: string;

        maxPerSecond: number;

        floatConfig: number;

        @IsInt()
        intProp = 'int';

        specialConfig(env: Record<string, string>): Partial<HarmonyEnvSubclass> {
          return {
            throttleDelay: env.THROTTLE === 'true' ? 1000 : 0,
          };
        }
      }

      this.dotEnvFile = await tmp.file();
      const envContent = 'SAME_REGION_ACCESS_ROLE=none\nAWS_DEFAULT_REGION=us-west-0\nMAX_PER_SECOND=900';
      await fs.writeFile(this.dotEnvFile.path, envContent, 'utf8');

      this.envDefaultsFile = await tmp.file();
      const defaultsContent = 'THROTTLE=false\nTHROTTLE_TYPE=fixed-window\nMAX_PER_SECOND=200\nFLOAT_CONFIG=3.5001';
      await fs.writeFile(this.envDefaultsFile.path, defaultsContent, 'utf8');

      this.env = new HarmonyEnvSubclass(this.envDefaultsFile.path, this.dotEnvFile.path);
    });
    after(async function () {
      await this.dotEnvFile.cleanup();
      await this.envDefaultsFile.cleanup();
    });

    it('can supply env values via its own env-defaults file', function () {
      expect(this.env.throttleType).to.eql('fixed-window');
    });

    it('can supply env values via its own env-defaults file', function () {
      expect(() => this.env.validate()).to.throw;
    });

    it('can set special case variables', function () {
      expect(this.env.throttleDelay).to.eql(0);
    });

    it('prefers process.env over .env', function () {
      expect(this.env.awsDefaultRegion).to.eql('us-east-3');
    });

    it('overrides util env-defaults with values read from process.env', function () {
      expect(this.env.clientId).to.eql('client-007');
    });

    it('overrides util env-defaults with .env file values', function () {
      expect(this.env.sameRegionAccessRole).to.eql('none');
    });

    it('overrides HarmonyEnvSubclass env-defaults with .env file values', function () {
      expect(this.env.maxPerSecond).to.eql(900);
    });

    it('parses floats from text', function () {
      expect(this.env.floatConfig).to.eql(3.5001);
    });

    it('throws an error when validated', function () {
      expect(() => this.env.validate()).to.throw;
    });

    it('logs one errors', function () {
      expect(getValidationErrors(this.env)).to.eql([
        {
          'children': [],
          'constraints': {
            'isInt': 'intProp must be an integer number',
          },
          'property': 'intProp',
          'value': 'int',
        },
      ]);
    });
  });
});