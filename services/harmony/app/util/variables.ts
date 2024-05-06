import { CmrCollection, CmrUmmVariable } from './cmr';
import { RequestValidationError } from './errors';
import { parseMultiValueParameter } from './parameter-parsing-helpers';

export interface HarmonyVariable {
  id: string;
  name: string;
  fullPath: string;
  relatedUrls?: HarmonyRelatedUrl[];
  type?: string;
  subtype?: string;
}

export interface HarmonyRelatedUrl {
  url: string;
  urlContentType: string;
  type: string;
  subtype?: string;
  description?: string;
  format?: string;
  mimeType?: string;
}

interface VariableInfo {
  collectionId: string;
  shortName: string; // collection short_name
  versionId: string; // collection version_id
  variables?: CmrUmmVariable[];
  coordinateVariables?: CmrUmmVariable[];
}

/**
 * Returns the harmony representation of a variable given a CMR UMM variable
 *
 * @param cmrVariable - The CMR UMM representation of a variable
 * @returns the Harmony representation of a variable
 */
export function cmrVarToHarmonyVar(cmrVariable: CmrUmmVariable): HarmonyVariable {
  const { umm, meta } = cmrVariable;
  const harmonyVariable: HarmonyVariable = {
    id: meta['concept-id'],
    name: umm.Name,
    fullPath: umm.Name,
  };

  if (umm.VariableType) {
    harmonyVariable.type = umm.VariableType;
  }

  if (umm.VariableSubType) {
    harmonyVariable.subtype = umm.VariableSubType;
  }

  if (umm.RelatedURLs) {
    harmonyVariable.relatedUrls = umm.RelatedURLs
      .map((relatedUrl) => {
        return {
          url: relatedUrl.URL,
          urlContentType: relatedUrl.URLContentType,
          type: relatedUrl.Type,
          subtype: relatedUrl.Subtype,
          description: relatedUrl.Description,
          format: relatedUrl.Format,
          mimeType: relatedUrl.MimeType,
        };
      });
  }

  return harmonyVariable;
}

/**
 * Get the full path for the given variable.
 * @param v - The variable of interest
 * @returns path - The full path to the variable
 */
export function fullPath(v: CmrUmmVariable): string {
  return v.umm.Name;
}

/**
 * Returns true if the string value matches the given variable's name or concept id
 * @param v - The variable to check
 * @param s - The string to match against the variable's name or concept id
 * @returns true if given value matches variable name or concept id
 */
function doesPathMatch(v: CmrUmmVariable, s: string): boolean {
  return s === v.umm.Name || s === v.meta['concept-id'];
}

const coordinateType = 'COORDINATE';

/**
 * Returns the coordinate variables from a list of variables
 * @param variables - An array of CMR UMM Variables
 * @returns The subset of variables that are coordinate variables
 */
export function getCoordinateVariables(variables: CmrUmmVariable[]): CmrUmmVariable[] {
  return variables.filter((v) => v.umm.VariableType === coordinateType);
}

/**
 * Given a list of EOSDIS collections and variables parsed from the CMR and an OGC
 * collectionId parameter return the full variables which match.
 *
 * @param eosdisCollections - An array of collections
 * @param collectionIdParam - The OGC collectionId query parameter
 * @returns an array of objects with a collectionId and list
 *   of variables e.g. `[{ collectionId: C123-PROV1, variables: [<Variable object>] }]`
 * @throws RequestValidationError - if the requested OGC collection ID parameter is not valid
 * based on the variables in the collections
 */
export function parseVariables(
  eosdisCollections: CmrCollection[],
  collectionIdParam: string,
  queryVars: string | string[] = null,
): VariableInfo[] {
  // Note that "collectionId" from the Open API spec is an OGC API Collection, which is
  // what we would call a variable (or sometimes a named group of variables).  In the
  // OpenAPI spec doc, a "collection" refers to a UMM-Var variable, and a "CMR collection" refers
  // to a UMM-C collection.  In the code, wherever possible, collections are UMM-C collections
  // and variables are UMM-Var variables.  The following line is the confusing part where we
  // translate between the two nomenclatures.
  let variableIds = collectionIdParam.split(',');
  const variableInfo = [];

  if (variableIds.indexOf('all') !== -1) {
    // If the variable ID is "all" do not subset by variable
    if (variableIds.length !== 1) {
      throw new RequestValidationError('"all" cannot be specified alongside other variables');
    }
    for (const collection of eosdisCollections) {
      const coordinateVariables = getCoordinateVariables(collection.variables);
      variableInfo.push({
        collectionId: collection.id, shortName: collection.short_name,
        versionId: collection.version_id, coordinateVariables,
      });
    }
  } else {
    if (variableIds.indexOf('parameter_vars') !== -1) {
      if (!queryVars) {
        throw new RequestValidationError('"parameter_vars" specified, but no variables given');
      } else {
        variableIds = parseMultiValueParameter(queryVars);
      }
    } else {
      // can't specify vars in the query AND in the path
      if (queryVars) {
        throw new RequestValidationError('Value "parameter_vars" must be used in the url path when variables are passed in the query parameters or request body');
      }
    }

    // Figure out which variables belong to which collections and whether any are missing.
    // Note that a single variable name may appear in multiple collections
    const missingVariables = new Set<string>(variableIds);
    for (const collection of eosdisCollections) {
      // Get the list of variables configured in services.yml for this collection. If the
      // returned set is empty then we will ignore it, otherwise we will only add variables
      // in that set
      const coordinateVariables = getCoordinateVariables(collection.variables);
      const variables = [];
      for (const variableId of variableIds) {
        const variable = collection.variables.find((v) => doesPathMatch(v, variableId));
        if (variable) {
          missingVariables.delete(variableId);
          // only add the variable to the list if it does not exist.
          // This is to guard against when variable name mixed with concept id that references the same variable
          if (variables.find(v => v.meta['concept-id'] === variable.meta['concept-id']) === undefined) {
            variables.push(variable);
          }
        }
      }
      variableInfo.push({
        collectionId: collection.id, shortName: collection.short_name,
        versionId: collection.version_id, variables, coordinateVariables,
      });
    }
    if (missingVariables.size > 0) {
      throw new RequestValidationError(`Coverages were not found for the provided variables: ${Array.from(missingVariables).join(', ')}`);
    }
  }
  return variableInfo;
}

/**
 * Helper to get the variables separately by collection.
 *
 * @param layers - The WMS layers provided with the request
 * @param collections - An array of the CMR Collections
 * @returns an object with the key being the collection and the value a list of
 * variables for that collection
 */
export function getVariablesForCollection(
  layers: string, collections: CmrCollection[],
): VariableInfo[] {
  const variablesByCollection = {};
  const collectionVariables = layers.split(',');
  for (const collectionVariableStr of collectionVariables) {
    const [collectionId, variableId] = collectionVariableStr.split('/');

    const collection = collections.find((c) => c.id === collectionId);
    if (!collection) {
      throw new RequestValidationError(`Invalid layer: ${collectionVariableStr}`);
    }

    if (!variablesByCollection[collectionId]) {
      variablesByCollection[collectionId] = [];
    }
    if (variableId) {
      const variable = collection.variables.find((v) => v.meta['concept-id'] === variableId);
      if (!variable) {
        throw new RequestValidationError(`Invalid layer: ${collectionVariableStr}`);
      }
      variablesByCollection[collectionId].push(variable);
    }
  }

  const variableInfo = [];
  for (const collection of collections) {
    const coordinateVariables = getCoordinateVariables(collection.variables);
    const variables = variablesByCollection[collection.id];
    variableInfo.push({
      collectionId: collection.id, shortName: collection.short_name,
      versionId: collection.version_id, variables, coordinateVariables,
    });
  }
  return variableInfo;
}