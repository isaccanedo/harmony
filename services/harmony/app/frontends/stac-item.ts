import { pick } from 'lodash';

import JobLink from '../models/job-link';

/**
 * An asset within a STAC item
 * https://github.com/radiantearth/stac-spec/blob/master/item-spec/item-spec.md#asset-object
 */
export interface StacAsset {
  href: string;
  title?: string;
  description?: string;
  type?: string;
  stac_extensions?: string[];
  roles?: ('thumbnail' | 'overview' | 'data' | 'metadata' | string)[];
}

export class HarmonyItem {
  id: string;

  stac_version: string;

  title: string;

  description: string;

  type: string;

  stac_extensions: string[];

  bbox: number[];

  geometry: {
    type?: string;
  };

  properties: {
    created?: string;
    datetime?: string;
    expires?: string;
  };

  assets: Record<string, StacAsset>;

  links: JobLink[];

  /**
   *
   * @param id - ID of the STAC Item
   * @param title - Title of the STAC Item
   * @param description - Description of the STAC Item
   * @param index - The index of this item in the STAC catalog
   */
  constructor(id: string, title: string, description: string, index: number) {
    this.id = `${id}_${index}`;
    this.stac_version = '1.0.0';
    this.title = title;
    this.description = description;
    this.type = 'Feature';
    this.stac_extensions = [
      'https://stac-extensions.github.io/timestamps/v1.0.0/schema.json',
    ];
    this.bbox = [];
    this.geometry = {};
    this.properties = {};
    this.assets = {};
    this.links = [];
  }

  /**
   * Adds GeoJSON Feature to the STAC Item
   * In future, this should take a polygon and derive a bounding box.
   *
   * @param bbox - GeoJSON bounding box
   */
  addSpatialExtent(bbox: number[]): void {
    // Validate bounding box; should be compliant with GeoJSON spec
    if (!bbox || bbox.length < 4) {
      throw new TypeError('Bounding box');
    }

    const west = bbox[0];
    const south = bbox[1];
    const east = bbox[2];
    const
      north = bbox[3];

    const geometry = {
      type: undefined,
      coordinates: [],
    };
    if (west > east) {
      // Case of bounding box crossing anti-meridian
      geometry.type = 'MultiPolygon';
      geometry.coordinates.push([]);
      geometry.coordinates[0].push([
        [-180, south],
        [-180, north],
        [east, north],
        [east, south],
        [-180, south],
      ]);
      geometry.coordinates[0].push([
        [west, south],
        [west, north],
        [180, north],
        [180, south],
        [west, south],
      ]);
    } else {
      geometry.type = 'Polygon';
      geometry.coordinates.push([
        [west, south],
        [west, north],
        [east, north],
        [east, south],
        [west, south],
      ]);
    }
    this.bbox = bbox;
    this.geometry = geometry;
  }

  /**
   * Adds links to a STAC Item
   *
   * @param url - Link URL
   * @param relType - Relation type: [self, root, item]
   * @param title - Link title (human readable)
   *
   */
  addLink(url: string, relType: string, title: string): void {
    this.links.push(
      new JobLink({
        href: url,
        rel: relType,
        title,
      }),
    );
  }

  /**
   * Adds temporal properties for a STAC Item
   *
   * @param start - Data start datetime
   * @param end - Data end datetime
   *
   */
  addTemporalExtent(start: Date | string, end: Date | string): void {
    const startString = typeof start === 'string' ? start : start.toISOString();
    const endString = typeof end === 'string' ? end : end.toISOString();

    this.setProperty('start_datetime', startString);
    this.setProperty('end_datetime', endString);
    this.setProperty('datetime', startString);
  }

  /**
   *  Adds expires property for a STAC item
   *
   * @param expires - Data expiration
   */
  addExpires(expires?: Date): void {
    if (expires) {
      this.setProperty('expires', expires.toISOString());
    }
  }

  /**
   * Sets a property for a STAC Item
   * @param name - Name of the property
   * @param value - Value of the property
   *
   */
  setProperty(name: string, value: string): void {
    this.properties[name] = value;
  }

  /**
   *
   * Adds an asset to the STAC Item
   *
   * @param href - Asset URL
   * @param title - Asset title
   * @param mimetype - Asset mimetype
   * @param role - Asset role [thumbnail,overview,data,metadata]
   *
   */
  addAsset(href: string, title: string, mimetype: string): void {
    let role = 'data';
    // Determine the role based on mimetype
    if (mimetype) {
      const [type, subtype] = mimetype.split('/');
      if (type === 'application') {
        if (subtype === 'json') {
          // application/json
          role = 'metadata';
        } else {
          // application/nc, application/octet-stream ...
          role = 'data';
        }
      } else if (type === 'image') {
        // image/*
        role = 'overview';
      } else if (type === 'text') {
        if (subtype === 'xml') {
          // text/xml
          role = 'metadata';
        } else {
          // text/plain, text/csv, ...
          role = 'data';
        }
      }
      this.assets[href] = {
        href,
        title,
        type: mimetype,
        roles: [role],
      };
    } else {
      // type is not required - if we do not have the mimetype do not include it
      this.assets[href] = {
        href,
        title,
        roles: [role],
      };
    }
  }

  /**
   * Placeholder method to support custom stringification
   *
   * @returns - STAC item JSON
   */
  toJSON(): object {
    const paths = ['id', 'stac_version', 'title', 'description', 'type', 'stac_extensions', 'bbox', 'geometry', 'properties', 'assets', 'links'];
    return pick(this, paths);
  }
}

/**
 * Function to create a STAC item
 *
 * @param jobID - Harmony job jobID string
 * @param jobRequest - Harmony job, job request string
 * @param stacDataLink - JobLink to convert into a STAC item
 * @param index - Index of the link item
 * @param linkType - the type of data links that the stac-items should use
 * @param createdAt - Date when the job was created
 *
 * @returns STAC Item JSON
 */
export default function create(
  jobID: string, jobRequest: string, stacDataLink: JobLink,
  index: number, linkType?: string, createdAt?: Date,
  expires?: Date,
): HarmonyItem {
  const title = `Harmony output #${index} in job ${jobID}`;
  const description = `Harmony out for ${jobRequest}`;
  const item = new HarmonyItem(jobID, title, description, index);

  // Set creation time
  const creationTime = createdAt || new Date();
  item.setProperty('created', creationTime.toISOString());
  // TBD: may be it should be a metadata for a Harmony service
  item.setProperty('license', 'various');
  // Add assets
  const {
    bbox,
    temporal,
    href,
    title: linkTitle,
    type,
  } = stacDataLink;
  item.addSpatialExtent(bbox);
  item.addTemporalExtent(temporal.start, temporal.end);
  item.addExpires(expires);
  item.addAsset(href, linkTitle, type);
  // Add linkType to links if defined and not null
  const selfUrl = linkType ? `./?linkType=${linkType}` : '.';
  const parentUrl = linkType ? `../?linkType=${linkType}` : '../';

  item.addLink(selfUrl, 'self', 'self');
  item.addLink(parentUrl, 'root', 'parent');
  return item;
}
