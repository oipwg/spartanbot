import RentalProvider from "./RentalProvider";
import NiceHash from 'nicehash-api'

class NiceHashProvider extends RentalProvider {
	constructor(settings) {
		super(settings)

		this.key = settings.api_key || settings.key;
		this.id = settings.api_id || settings.id

		this.api = new NiceHash(this.key, this.id)
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
		let pool = {...options, market: this.getInternalType(), providerUID: this.getUID()};
		this.addPools(pool)

		if (!this._returnActivePool())
			this._setActivePool(pool.id)
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
	 * Update a pool
	 * @param {(number|Array.<number>)} poolIDs - IDs of the pools you wish to update
	 * @param {string|number} id - pool id
	 * @param {Object} [options]
	 * @param {string} [options.type] - Pool algo, eg: sha256, scrypt, x11, etc
	 * @param {string} [options.name] - Name to identify the pool with
	 * @param {string} [options.host] - Pool host, the part after stratum+tcp://
	 * @param {number} [options.port] - Pool port, the part after the : in most pool host strings
	 * @param {string} [options.user] - Your workname
	 * @param {string} [options.pass] - Worker password
	 * @param {string} [options.notes] - Additional notes to help identify the pool for you
	 * @async
	 * @returns {Promise<Object>}
	 */
	async _updatePool(id, options) {
		for (let pool of this.pools) {
			if (pool.id === id || pool.mrrID === id) {
				for (let opt in pool) {
					for (let _opt in options) {
						if (_opt === 'host' && opt === 'pool_host')
							pool[opt] = options[_opt]
						if (_opt === 'port' && opt === 'pool_port')
							pool[opt] = options[_opt]
						if (_opt === 'user' && opt === 'pool_user')
							pool[opt] = options[_opt]
						if (_opt === 'pass' && opt === 'pool_pass')
							pool[opt] = options[_opt]
						if (_opt === 'type' && opt === 'algo')
							pool[opt] = options[_opt]
						if (opt === _opt) {
							pool[opt] = options[_opt]
						}
					}
				}
			}
		}
		return {success: true,  data: { id, success: true, message: 'Updated' }}
	}

	/**
	 * Internal function to get Pools
	 * @async
	 * @private
	 * @return {Array.<Object>}
	 */
	async _getPools() {
		return await this.pools
	}

	/**
	 * Set pool to active
	 * poolid
	 * @private
	 */
	_setActivePool(poolid) {
		this.activePool = poolid
	}

	/**
	 * return active pool
	 * @private
	 */
	_returnActivePool() {
		return this.activePool
	}

	/**
	 * Create new order. Only standard orders can be created with use of API.
	 * @param options
	 * @param {string|number} options.amount - Pay amount in BTC;
	 * @param {string|number} options.price - Price in BTC/GH/day or BTC/TH/day;
	 * @param {string|number} [options.algo='scrypt'] - Algorithm name or ID
	 * @param {string|number} [options.limit=0] - Speed limit in GH/s or TH/s (0 for no limit);
	 * @param {string|number} [options.location=1] - 0 for Europe (NiceHash), 1 for USA (WestHash);
	 * @param {string} [options.pool_host] - Pool hostname or IP;
	 * @param {string} [options.pool_port] - Pool port
	 * @param {string} [options.pool_user] - Pool username
	 * @param {string} [options.pool_pass] - Pool password
	 * @param {string|number} [options.code] - This parameter is optional. You have to provide it if you have 2FA enabled. You can use NiceHash2FA Java application to generate codes.
	 * @async
	 * @returns {Promise<Object>}
	 */
	async manualRent(options) {
		if (!this.id || !this.key)
			throw new Error('Must provide api key and api id on initialize')

		if (options.amount < 0.005)
			throw new Error(`The minimum amount to pay is 0.005 BTC`)

		if (options.limit && options.limit < 0.01) {
			throw new Error(`The minimum limit is 0.01`)
		}

		let poolID = this._returnActivePool();
		let _pool = {};
		for (let pool of this.pools) {
			if (pool.id === poolID)
				_pool = pool
		}
		options.algo = options.algo || 'scrypt'
		options.limit = options.limit || '0';
		options.location = options.location || '1'

		let rentOptions = {};
		for (let opt in options) {
			rentOptions[opt] = options[opt]
		}
		rentOptions = {...rentOptions, ..._pool}

		try {
			return await this.api.createOrder(rentOptions)
		} catch (err) {
			throw new Error(`Error creating NiceHash order: ${err}`)
		}
	}



}

export default NiceHashProvider