import RentalProvider from "./RentalProvider";
import NiceHash from 'nicehash-api'

class NiceHashProvider extends RentalProvider {
	constructor(settings) {
		super(settings)

		this.api = new NiceHash(settings.api_key, settings.api_id)
	}

	/**
	 * Get the "type" of this RentalProvider
	 * @return {String} Returns "NiceHash"
	 * @static
	 */
	static getType(){
		return "NiceHash"
	}

	/**
	 * Non static method to get type
	 * @return {String} returns "NiceHash"
	 */
	getInternalType() {
		return "NiceHash"
	}

	/**
	 * Test Authorization
	 * @async
	 * @returns {Promise<Boolean>}
	 */
	async _testAuthorization(){
		try {
			return await this.api.testAuthorization()
		} catch(err) {
			throw new Error(`Authorization failed: ${err}`)
		}
	}

	/**
	 * Get Balance
	 * @async
	 * @returns {Promise<Number>}
	 */
	async _getBalance() {
		try {
			return await this.api.getBalance()
		} catch (err) {
			throw new Error(`Failed to get balance: ${err}`)
		}
	}

	/**
	 * Create Pool
	 * @param {string|number} options.algo - Algorithm name or ID
	 * @param {string} options.pool_host - Pool hostname or IP;
	 * @param {string} options.pool_port - Pool port
	 * @param {string} options.pool_user - Pool username
	 * @param {string} options.pool_pass - Pool password
	 * @param {string} options.name - Name to identify the pool with
	 * @param {number} [options.id] - Local ID (an arbitrary id you can give it for more control)
	 * @param {string|number} [options.location=0] - 0 for Europe (NiceHash), 1 for USA (WestHash);
	 * @return {Object}
	 */
	_createPool(options) {
		if (!options.pool_host || !options.pool_port || !options.pool_user || !options.pool_pass) {
			return {success: false, message: 'must provide all of the following: pool_host, pool_port, pool_user, pool_pass'}
		}
		let pool = {...options};
		this.addPools(pool)
		return pool
	}

	/**
	 * Delete pool from local variable, this.pools
	 * @param id
	 * @returns {Promise<Object>}
	 * @private
	 */
	async _deletePool(id) {
		for (let pool in this.pools) {
			if (this.pools[pool].id === id) {
				this.pools.splice(pool, 1)
			}
		}
		for (let pool of this.pools) {
			if (pool.id === id) {
				return {success: false, message: 'failed to remove pool with .splice'}
			}
		}
		return {success: true, message: `Pool: ${id} removed.`}
	}

	/**
	 * Internal function to get Pools
	 * @async
	 * @return {Array.<Object>}
	 */
	async _getPools() {
		return await this.pools
	}

	/**
	 * Set pool to active
	 * poolid
	 */
	_setActivePool(poolid) {
		this.activePool = poolid
	}

}

export default NiceHashProvider