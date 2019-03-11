'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

var __chunk_1 = require('./chunk.js');

/**
 * Open a database.
 *
 * @param name Name of the database.
 * @param version Schema version.
 * @param callbacks Additional callbacks.
 */
function openDB(name, version, callbacks = {}) {
    const { blocked, upgrade, blocking } = callbacks;
    const request = indexedDB.open(name, version);
    const openPromise = __chunk_1.wrap(request);
    if (upgrade) {
        request.addEventListener('upgradeneeded', (event) => {
            upgrade(__chunk_1.wrap(request.result), event.oldVersion, event.newVersion, __chunk_1.wrap(request.transaction));
        });
    }
    if (blocked)
        request.addEventListener('blocked', () => blocked());
    if (blocking)
        openPromise.then(db => db.addEventListener('versionchange', blocking));
    return openPromise;
}
/**
 * Delete a database.
 *
 * @param name Name of the database.
 */
function deleteDB(name, callbacks = {}) {
    const { blocked } = callbacks;
    const request = indexedDB.deleteDatabase(name);
    if (blocked)
        request.addEventListener('blocked', () => blocked());
    return __chunk_1.wrap(request).then(() => undefined);
}

function potentialDatabaseExtra(target, prop) {
    return (target instanceof IDBDatabase) &&
        !(prop in target) &&
        typeof prop === 'string';
}
const readMethods = ['get', 'getKey', 'getAll', 'getAllKeys', 'count'];
const writeMethods = ['put', 'add', 'delete', 'clear'];
// Add index methods
readMethods.push(...readMethods.map(n => n + 'FromIndex'));
const cachedMethods = new Map();
function getMethod(prop) {
    if (readMethods.includes(prop)) {
        return function (storeName, ...args) {
            // Are we dealing with an index method?
            let indexName = '';
            let targetFuncName = prop;
            if (targetFuncName.endsWith('FromIndex')) {
                indexName = args.shift();
                targetFuncName = targetFuncName.slice(0, -9); // remove "FromIndex"
            }
            const tx = this.transaction(storeName);
            let target = tx.store;
            if (indexName)
                target = target.index(indexName);
            return target[targetFuncName](...args);
        };
    }
    if (writeMethods.includes(prop)) {
        return function (storeName, ...args) {
            const tx = this.transaction(storeName, 'readwrite');
            tx.store[prop](...args);
            return tx.done;
        };
    }
}
__chunk_1.addTraps(oldTraps => ({
    get(target, prop, receiver) {
        // Quick bails
        if (!potentialDatabaseExtra(target, prop)) {
            return oldTraps.get(target, prop, receiver);
        }
        // tslint:disable-next-line:no-parameter-reassignment
        prop = prop;
        const cachedMethod = cachedMethods.get(prop);
        if (cachedMethod)
            return cachedMethod;
        const method = getMethod(prop);
        if (method) {
            cachedMethods.set(prop, method);
            return method;
        }
        return oldTraps.get(target, prop, receiver);
    },
    has(target, prop) {
        return (potentialDatabaseExtra(target, prop) &&
            (readMethods.includes(prop) || writeMethods.includes(prop))) || oldTraps.has(target, prop);
    },
}));

exports.unwrap = __chunk_1.unwrap;
exports.wrap = __chunk_1.wrap;
exports.openDB = openDB;
exports.deleteDB = deleteDB;
