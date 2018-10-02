import RentalProvider from "./RentalProvider";
import NiceHash from 'nicehash-api'
import uid from 'uid'

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
	 * @param {string|number} [options.location=0] - 0 for Europe (NiceHash), 1 for USA (WestHash);
	 * @return {Object}
	 */
	_createPool(options) {
		if (!options.pool_host || !options.pool_port || !options.pool_user || !options.pool_pass) {
			return {success: false, message: 'must provide all of the following: pool_host, pool_port, pool_user, pool_pass'}
		}
		let pool = {...options, id: uid()};
		this.addPools(pool)
		return pool
	}

	/**
	 * Internal function to get Pools
	 * @async
	 * @return {Array.<Object>}
	 */
	async _getPools() {
		return await this.pools
	}
}

export default NiceHashProvider