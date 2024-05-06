import { expect } from 'chai';
import { describe, it, before } from 'mocha';
import { v4 as uuid } from 'uuid';
import url from 'url';
import { JobStatus } from '../../app/models/job';
import { buildJob } from '../helpers/jobs';
import hookServersStartStop from '../helpers/servers';
import { hookTransaction } from '../helpers/db';
import { hookStacCatalog } from '../helpers/stac';
import env from '../../app/util/env';

const runningJobProps = {
  username: 'joe',
  status: JobStatus.RUNNING,
  message: 'it is running',
  progress: 42,
  links: [{
    href: 'http://example.com',
    type: 'application/octet-stream',
    rel: 'data',
    bbox: [-10, -10, 10, 10],
    temporal: {
      start: new Date('2020-01-01T00:00:00.000Z'),
      end: new Date('2020-01-01T01:00:00.000Z'),
    },
  }],
  request: 'http://example.com/harmony?job=runningJob',
  numInputGranules: 100,
};

const completedJobProps = {
  username: 'joe',
  status: JobStatus.SUCCESSFUL,
  message: 'it is done',
  progress: 100,
  links: [{
    href: 'http://example.com',
    type: 'application/octet-stream',
    rel: 'data',
    bbox: [-10, -10, 10, 10],
    temporal: {
      start: new Date('2020-01-01T00:00:00.000Z'),
      end: new Date('2020-01-01T01:00:00.000Z'),
    },
  }],
  request: 'http://example.com/harmony?job=completedJob',
  numInputGranules: 5,
};

describe('STAC catalog route', function () {
  hookServersStartStop({ skipEarthdataLogin: false });
  hookTransaction();
  const runningJob = buildJob(runningJobProps);
  const completedJob = buildJob(completedJobProps);
  before(async function () {
    await runningJob.save(this.trx);
    await completedJob.save(this.trx);
    this.trx.commit();
  });
  const jobId = runningJob.requestId;

  describe('For a non-existent job ID without user info', function () {
    const unknownRequest = uuid();
    hookStacCatalog(unknownRequest);
    it('returns a 404 HTTP Not found response', function () {
      expect(this.res.statusCode).to.equal(404);
    });

    it('returns a JSON error response', function () {
      const response = JSON.parse(this.res.text);
      expect(response).to.eql({
        code: 'harmony.NotFoundError',
        description: `Error: Unable to find job ${unknownRequest}`,
      });
    });
  });

  describe('For a non-existent job ID', function () {
    const unknownRequest = uuid();
    hookStacCatalog(unknownRequest, 'joe');
    it('returns a 404 HTTP Not found response', function () {
      expect(this.res.statusCode).to.equal(404);
    });

    it('returns a JSON error response', function () {
      const response = JSON.parse(this.res.text);
      expect(response).to.eql({
        code: 'harmony.NotFoundError',
        description: `Error: Unable to find job ${unknownRequest}`,
      });
    });
  });

  describe('For an invalid job ID format', function () {
    hookStacCatalog('not-a-uuid', 'joe');
    it('returns a 404 HTTP Not found response', function () {
      expect(this.res.statusCode).to.equal(400);
    });

    it('returns a JSON error response', function () {
      const response = JSON.parse(this.res.text);
      expect(response).to.eql({
        code: 'harmony.RequestValidationError',
        description: 'Error: jobId not-a-uuid is in invalid format.',
      });
    });
  });

  const tests = [{
    description: 'with a logged-in user who owns the job',
    userName: 'joe',
  }, {
    description: 'with a guest user who does not own the job',
    userName: null,
  }];
  for (const test of tests) {
    describe(test.description, function () {
      describe('when the job is incomplete', function () {
        hookStacCatalog(jobId, test.userName);
        it('returns an HTTP not implemented response', function () {
          expect(this.res.statusCode).to.equal(409);
        });

        it('returns a JSON error response', function () {
          const response = JSON.parse(this.res.text);
          expect(response).to.eql({
            code: 'harmony.ConflictError',
            description: `Error: Job ${jobId} is not complete`,
          });
        });
      });

      describe('when the job is complete', function () {
        describe('when the service supplies the necessary fields', async function () {
          const completedJobId = completedJob.requestId;
          hookStacCatalog(completedJobId, test.userName);

          it('returns an HTTP OK response', function () {
            expect(this.res.statusCode).to.equal(200);
          });

          it('returns a STAC catalog in JSON format', function () {
            const reqUrl = new url.URL(this.res.request.url);
            const catalog = JSON.parse(this.res.text);
            expect(catalog.description).to.equal('Harmony output for http://example.com/harmony?job=completedJob');
            expect(catalog.id).to.equal(completedJob.requestId);
            expect(catalog.links).to.eql([
              { href: '.', rel: 'root', title: 'root' },
              { href: './0', rel: 'item' },
              {
                href: `${reqUrl.origin}/stac/${completedJob.requestId}?page=1&limit=${env.defaultResultPageSize}`,
                rel: 'self',
                title: 'The current page',
                type: 'application/json',
              },
            ]);
            expect(catalog.stac_version).to.equal('1.0.0');
            expect(catalog.title).to.include('Harmony output for ');
            expect(catalog.type).to.equal('Catalog');
          });
        });
        describe('when the linkType is invalid', function () {
          const completedJobId = completedJob.requestId;
          hookStacCatalog(completedJobId, test.userName, { linkType: 'foo' });
          // HARMONY-770 AC 8
          it('returns a 400 status', function () {
            expect(this.res.statusCode).to.equal(400);
          });
          it('returns an informative error', function () {
            expect(this.res.error.text).to.match(/^{"code":"harmony.RequestValidationError","description":"Error: Invalid linkType 'foo' must be http, https, or s3"}/);
          });
        });
      });
    });
  }
});
