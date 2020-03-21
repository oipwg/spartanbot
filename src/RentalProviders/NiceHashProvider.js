import RentalProvider from "./RentalProvider";
import NiceHash from 'nicehash-api'
import {getDuration, getEstAmountSpent, serializePool, toMRRAmount} from "../util";
import {ERROR, NORMAL, WARNING, LOW_LIMIT, LOW_BALANCE, CUTOFF} from "../constants";

class NiceHashProvider extends RentalProvider {
	constructor(settings) {
		super(settings)

		this.api_key = settings.api_key || settings.key;
		this.api_id = settings.api_id || settings.id

		this.api = new NiceHash(this.api_key, this.api_id)
	}

	/**
	 * Get the "type" of this RentalProvider
	 * @return {String} Returns "NiceHash"
	 * @static
	 */
	static getType() {
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
	async _testAuthorization() {
		try {
			return await this.api.testAuthorization()
		} catch (err) {
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
			return {
				success: false,
				message: 'must provide all of the following: pool_host, pool_port, pool_user, pool_pass'
			}
		}
		let pool = {...options, market: this.getInternalType(), providerUID: this.getUID()};
		this._addPools(pool)
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
			if (!Object.prototype.hasOwnProperty.call(this.pools, pool)) continue
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
					if (!Object.prototype.hasOwnProperty.call(pool, opt)) continue
					for (let _opt in options) {
						if (!Object.prototype.hasOwnProperty.call(options, _opt)) continue
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
		return {success: true, data: {id, success: true, message: 'Updated'}}
	}

	/**
	 * Internal function to get Pools
	 * @async
	 * @private
	 * @return {Array.<Object>}
	 */
	async _getPools() {
		return this.pools
	}

	_addPools(pools) {
		if (Array.isArray(pools)) {
			for (let pool of pools) {
				let match = false
				for (let p of this.pools) {
					if (p.id === pool.id)
						match = true
				}
				if (!match)
					this.pools.push(serializePool(pool, this.getInternalType()))

			}
		} else {
			let match = false
			for (let p of this.pools) {
				if (p.id === pools.id)
					match = true
			}
			if (!match)
				this.pools.push(serializePool(pools, this.getInternalType()))
		}
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

	async preprocessRent(hashrate, duration) {
		let status = {status: NORMAL}
		let balance;
		try {
			balance = Number(await this.getBalance())
		} catch (err) {
			status.status = ERROR
			return {success: false, message: 'failed to get balance', status}
		}

		const hashrateTH = hashrate / 1000 / 1000
		const minimumAmount = 0.005
		const minimumLimit = 0.01

		if (balance < minimumAmount || hashrateTH < minimumLimit) {
			status.status = ERROR
			let message
			if (balance < minimumAmount) {
				message = `Balance must be >= 0.005`
				status.type = LOW_BALANCE
			}
			if (hashrateTH < minimumLimit) {
				message = `Hashrate/limit must be >= 0.01 TH (10,000 MH)`
				status.type = LOW_LIMIT
			}
			return {success: false, message, status}
		}

		//get price, amount, hash
		let marketPrice;
		try {
			let stats = await this.api.getCurrentGlobalStats24h()
			for (let stat of stats) {
				if (stat.algo === "Scrypt") {
					marketPrice = stat.price
					break
				}
			}
		} catch (err) {
			status.status = ERROR;
			status.type = 'HTML_ERROR';
			status.error = err;
			status.message = `Failed to get current global nice hash stats`
		}

		const desiredDuration = duration
		const price = marketPrice
		const limit = hashrateTH
		let amount = minimumAmount

		let idealAmount = toMRRAmount(price, duration, limit)
		if (idealAmount <= balance && idealAmount >= minimumAmount) {
			//rent at ideal amount for ideal time
			amount = idealAmount
		} else if (idealAmount > balance) {
			//rent at balance for shorter duration
			amount = balance
			duration = getDuration(price, limit, amount)

			// -------STATUS---------
			status.status = WARNING
			status.type = LOW_BALANCE
			status.costToRent = idealAmount
			status.balance = balance
			status.fundsNeeded = (idealAmount - balance).toFixed(6)
			status.duration = duration
			status.price = price
			status.desiredDuration = desiredDuration
			status.message = `Don't have high enough balance to rent hash for desired duration.`
		} else {
			//rent at minimum for longer duration
			amount = minimumAmount
			duration = getDuration(price, limit, amount)

			// -------STATUS---------
			status.status = WARNING
			status.type = CUTOFF
			status.message = 'Ideal amount to spend for desired limit/duration is below minimum amount. ' +
				'Either cutoff rental at desired duration or let rental finish calculated time for 0.005 BTC'
			status.totalDuration = duration
			status.extendedDuration = duration - desiredDuration
			status.desiredDuration = desiredDuration
			status.idealAmount = idealAmount
			status.cost = amount
			status.amountOver = amount - idealAmount
			status.cutoffCost = getEstAmountSpent(price, limit, desiredDuration)
		}

		return {
			market: "NiceHash",
			status,
			amount,
			totalHashesTH: limit * 60 * 60 * duration,
			hashesDesiredTH: hashrateTH * 60 * 60 * desiredDuration,
			duration,
			limit,
			price,
			balance,
			query: {
				hashrate_found: limit,
				cost_found: idealAmount,
				duration: desiredDuration
			},
			uid: this.getUID(),
			provider: this,
		}

	}

	/**
	 * Create new order. Only standard orders can be created with use of API. Gets passed a badge by RentalProvider
	 * @param options
	 * @param {string|number} options.amount - Pay amount in BTC;
	 * @param {string|number} options.price - Price in BTC/GH/day or BTC/TH/day;
	 * @param {string|number} [options.limit=0.01] - Speed limit in GH/s or TH/s (0 for no limit);
	 * @param {string|number} [options.algo='scrypt'] - Algorithm name or ID
	 * @param {string|number} [options.location=1] - 0 for Europe (NiceHash), 1 for USA (WestHash);
	 * @param {string} [options.pool_host] - Pool hostname or IP;
	 * @param {string} [options.pool_port] - Pool port
	 * @param {string} [options.pool_user] - Pool username
	 * @param {string} [options.pool_pass] - Pool password
	 * @param {string|number} [options.code] - This parameter is optional. You have to provide it if you have 2FA enabled. You can use NiceHash2FA Java application to generate codes.
	 * @async
	 * @returns {Promise<Object>}
	 */
	async _rent(options) {
		if (!this.api_key || !this.api_id)
			throw new Error('Must provide api key and api id on initialize')

		if (options.amount < 0.005)
			throw new Error(`The minimum amount to pay is 0.005 BTC`)

		if (options.limit && options.limit < 0.01) {
			throw new Error(`The minimum limit is 0.01`)
		}

		if (!this.returnPools()) {
			return {success: false, message: `No pool found`, status: ERROR}
		}

		if (!this._returnActivePool()) {
			return {success: false, message: `No active pool set`, status: ERROR}
		}

		let poolID = this._returnActivePool();
		let _pool = {};
		for (let pool of this.pools) {
			if (pool.id === poolID)
				_pool = pool
		}
		options.algo = options.algo || 'scrypt'
		options.limit = options.limit || '0.01';
		options.location = options.location || '1'

		let rentOptions = {};
		for (let opt in options) {
			rentOptions[opt] = options[opt]
		}
		rentOptions = {...rentOptions, ..._pool}

		let res;
		try {
			res = await this.api.createOrder(rentOptions)
		} catch (err) {
			return {success: false, message: `Failed to create NiceHash order`, error: err, status: ERROR}
		}
		let id, success = true
		if (res.result && res.result.success) {
			let orderSuccess = res.result.success
			let split = orderSuccess.split(' ')
			let order = split[1]
			id = order.substr(1)
		} else {
			success = false
		}

		return {
			market: "NiceHash",
			success,
			amount: options.amount,
			limit: options.limit,
			price: options.price,
			duration: options.duration,
			status: options.status,
			res,
			id,
			cutoff: options.cutoff,
			uid: this.getUID()
		}
	}

	/**
	 * Cancel NiceHash rental
	 * @param {string|number} id - the id of the order you wish to cancel
	 * @param {string|number} [location=1] - 0 for Europe, 1 for AMERICA
	 * @param {string|number} [algo='scrypt'] - the algorithm the rental is running
	 * @private
	 * @async
	 * @returns {Promise<Object>}
	 */
	async _cancelRental(id, location, algo) {
		let res;
		try {
			res = await this.api.removeOrder(id)
		} catch (err) {
			return {success: false, error: err, errorType: 'NETWORK', id}
		}

		if (res.error) {
			return {success: false, error: res.error, errorType: 'NICEHASH', id}
		} else {
			return {success: true, data: res, id}
		}
	}
}

export default NiceHashProvider
