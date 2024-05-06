import { describe, it } from 'mocha';
import { expect } from 'chai';
import boxStringsToBox from '../../app/util/bounding-box';

describe('util/bounding-box', function () {
  describe('boxStringsToBox', function () {
    // inputs are in SWNE order

    it('returns the ordinates in WSEN order', function () {
      const input = ['-35.0 -100.0 35.0 100.0'];
      expect(boxStringsToBox(input)).to.eql([-100.0, -35.0, 100.0, 35.0]);
    });
  });

  describe('when given more than one box', function () {
    it('returns a single box that covers all', function () {
      const input = [
        '-35.0 -100.0 35.0 10.0',
        '10.0 11.0 15.1 17.4',
        '-40.1 -90, 30.2 10.4',
      ];
      expect(boxStringsToBox(input)).to.eql([-100, -40.1, 17.4, 35.0]);
    });

    it('handles boxes that cross the antimeridian', function () {
      const input = [
        '-35.0 100.0 35.0 -100.0', // crosses AM
        '10.0 11.0 15.1 17.4',
        '-40.1 -90, 30.2 10.4',
      ];
      expect(boxStringsToBox(input)).to.eql([100, -40.1, 17.4, 35]);
    });
  });

  describe('when given an empty input', function () {
    it('returns null', function () {
      const input = [];
      expect(boxStringsToBox(input)).to.be.null;
    });
  });

  describe('when given a null input', function () {
    it('returns null', function () {
      const input = null;
      expect(boxStringsToBox(input)).to.be.null;
    });
  });

  describe('when given a bad input', function () {
    it('throws an exception', function () {
      const input = ['1 2 3 4', '1 2'];
      expect(() => boxStringsToBox(input)).to.throw(/expected bounding box to have 4 bounds, got 2/);
    });
  });
});
