import path from 'path';
import _ from 'lodash';
import StacCatalog from './catalog';
import StacItem from './item';
import { CmrGranule } from '../../../harmony/app/util/cmr';
import { computeMbr } from '../../../harmony/app/util/spatial/mbr';
import logger from '../../../harmony/app/util/log';
import { Logger } from 'winston';

/**
 * Creates a GeoJSON geometry given a GeoJSON BBox, accounting for antimeridian
 *
 * @param bbox - the bounding box to create a geometry from
 * @returns a Polygon or MultiPolygon representation of the input bbox
 */
export function bboxToGeometry(bbox: GeoJSON.BBox): GeoJSON.Geometry {
  const [west, south, east, north] = bbox;
  if (west > east) {
    return {
      type: 'MultiPolygon',
      coordinates: [
        [[
          [-180, south],
          [-180, north],
          [east, north],
          [east, south],
          [-180, south],
        ]],
        [[
          [west, south],
          [west, north],
          [180, north],
          [180, south],
          [west, south],
        ]],
      ],
    };
  }
  return {
    type: 'Polygon',
    coordinates: [[
      [west, south],
      [west, north],
      [east, north],
      [east, south],
      [west, south],
    ]],
  };
}

/**
 * Implementation of StacCatalog that can obtain its children from CMR atom results
 */
export default class CmrStacCatalog extends StacCatalog {
  /**
   * Adds the given CMR Atom granules as child items of this catalog
   * @param granules - the atom granules to add
   * @param pathPrefix - the prefix to use for href values on the link.  The link href will be
   *   the path prefix followed by the padded index of the granule plus .json
   * @param granuleLogger - The logger to use for logging messages
   */
  addCmrGranules(granules: CmrGranule[], pathPrefix: string, granuleLogger: Logger = logger): void {
    for (let i = 0; i < granules.length; i++) {
      const granule = granules[i];
      const bbox = computeMbr(granule) || [-180, -90, 180, 90];
      const geometry = bboxToGeometry(bbox);
      const isOpenDapLink = (l): boolean => (l.title && (l.title.toLowerCase().indexOf('opendap') !== -1))
        || (l.href.toLowerCase().indexOf('opendap') !== -1);
      const links = (granule.links || []).filter((g) => (!g.inherited
        && (g.rel.endsWith('/data#') || (g.rel.endsWith('/service#') && isOpenDapLink(g)))));
      const [opendapLinks, dataLinks] = _.partition(links, (l) => isOpenDapLink(l));
      // Give the first data link the title 'data' and suffix subsequent ones with their index
      const dataAssets = dataLinks.map((link, j) => ([
        `data${j === 0 ? '' : j}`,
        {
          href: link.href,
          title: path.basename(link.href),
          description: link.title,
          type: link.type,
          roles: ['data'],
        },
      ]));
      const opendapAssets = opendapLinks.map((link, j) => ([
        `opendap${j === 0 ? '' : j}`,
        {
          href: link.href,
          title: path.basename(link.href),
          description: link.title,
          type: link.type,
          roles: ['data', 'opendap'],
        },
      ]));
      const assets = _.fromPairs(dataAssets.concat(opendapAssets));

      if (Object.keys(assets).length === 0) {
        granuleLogger.warn(`Granule ${granule.id} had no data links and will be excluded from results`);
      } else {
        const item = new StacItem({
          bbox,
          geometry,
          assets,
          properties: {
            start_datetime: granule.time_start,
            end_datetime: granule.time_end,
            datetime: granule.time_start,
          },
        });
        this.children.push(item);

        const indexStr = `${i}`.padStart(7, '0');
        this.links.push({
          rel: 'item',
          href: `${pathPrefix}${indexStr}.json`,
          type: 'application/json',
          title: granule.title,
        });
      }
    }
  }
}
