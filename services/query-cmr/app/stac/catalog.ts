import { strict as assert } from 'assert';
import { v4 as uuid } from 'uuid';
import _ from 'lodash';
import StacItem from './item';
import { StacCatalog, StacLink } from './types';
import { objectStoreForProtocol } from '../../../harmony/app/util/object-store';
import { resolve } from '../../../harmony/app/util/url';

/**
 * Implementation of the StacCatalog type with constructor, write function, and ability
 * to add children
 */
export default class Catalog implements StacCatalog {
  stac_version: string;

  stac_extensions?: string[];

  id: string;

  links: StacLink[];

  description: string;

  title?: string;

  children: (Catalog | StacItem)[];

  /**
   * Constructs a Catalog with the given properties.  At least description
   * is required
   * @param properties - the properties to set on the catalog (description is required)
   */
  constructor(properties: Partial<StacCatalog>) {
    this.stac_version = '1.0.0-beta.2';
    this.stac_extensions = [];
    this.id = uuid();
    this.links = [];
    this.children = [];
    Object.assign(this, properties);
    assert(!!this.description, 'Catalog description is required');
  }

  /**
   * Used in JSON serialization, returns an object that, when serialized
   * to JSON, is a valid StacCatalog.  Omits children.
   * @returns a JSON serializable representation of this catalog
   */
  toJSON(): StacCatalog {
    return _.omit(this, 'children') as unknown as StacCatalog;
  }

  /**
   * Writes this catalog and all of its children to s3, with child file paths determined
   * by their relative link paths
   * @param fileUrl - the full path to the file where this catalog should be written
   * @param pretty - if output JSON should be pretty-formatted
   */
  async write(fileUrl: string, pretty = false): Promise<void> {
    const s3 = objectStoreForProtocol('s3');
    const childLinks = this.links.filter((l) => l.rel === 'child' || l.rel === 'item');
    const promises: Promise<void | object>[] = this.children.map(async (item, i) => {
      const itemFilename = resolve(fileUrl, childLinks[i].href);
      return item.write(itemFilename, pretty);
    });
    const json = pretty ? JSON.stringify(this, null, 2) : JSON.stringify(this);
    promises.push(s3.upload(json, fileUrl, null, 'application/json'));
    await Promise.all(promises);
  }
}
