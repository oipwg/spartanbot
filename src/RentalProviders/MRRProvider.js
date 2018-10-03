import RentalProvider from './RentalProvider'
import MiningRigRentals from 'miningrigrentals-api-v2'
import {selectBestCombination} from "../util";

/**
 * A Rental Provider for MiningRigRentals
 */
class MRRProvider extends RentalProvider {
	/**
	 * Create a new MRR Provider
	 * @param  {Object} settings - Settings for the RentalProvider
	 * @param {String} settings.api_key - The API Key for the Rental Provider
	 * @param {String} settings.api_secret - The API Secret for the Rental Provider
	 * @param {String} settings.name - Alias/arbitrary name for the provider
	 * @param {String} [settings.uid] - The unique identifier for this Rental Provider
	 * @return {MRRProvider}
	 */
	constructor(settings){
		super(settings)

		this.api = new MiningRigRentals({key: this.api_key, secret: this.api_secret})
	}

	/**
	 * Get the "type" of this RentalProvider
	 * @return {String} Returns "MiningRigRentals"
	 * @static
	 */
	static getType(){
		return "MiningRigRentals"
	}

	/**
	 * Non static method to get type
	 * @return {String} returns "MiningRigRentals"
	 */
	getInternalType() {
		return "MiningRigRentals"
	}

	/**
	 * Test to make sure the API key and secret are correct
	 * @return {Promise} Returns a Promise that will resolve upon success, and reject on failure
	 */
	async _testAuthorization(){
		try {
			let profile = await this.api.whoami();
			return !!(profile.success && profile.data && profile.data.authed);
		} catch (err) {
			throw new Error(err)
		}
	}

	/**
	 * Fetch active rigs (rentals) (called by parent class RentalProvider)
	 * @returns {Promise<Array.<number>>} - returns an array of rig IDs
	 * @private
	 */
	async _getActiveRigs() {
		try {
			let response = await this.api.getRentals()
			if (response.success) {
				let data = response.data;
				if (data) {
					let rentals = data.rentals
					let rigs = []
					for (let rental of rentals) {
						if (rental.rig && rental.rig.id)
							rigs.push(Number(rental.rig.id))
					}
					return rigs
				}
			}
		} catch (err) {
			throw new Error(`Could not fetch rentals \n ${err}`)
		}
	}

	/**
	 * Get MiningRigRentals Profile ID (needed to rent rigs)
	 * @returns {Promise<number>} - the id of the first data object
	 */
	async getProfileID() {
		let profile;
		try {
			profile = await this.api.getPoolProfiles();
		} catch (err) {
			throw new Error(`error getting profile data: ${err}`)
		}
		if (profile.success) {
			//ToDo: be able to pick a pool profile to use
			if (profile.data.length === 0) {
				throw new Error(`No profile data. Consider creating a pool/profile`)
			} else {
				return Number(profile.data[0].id)
			}
		} else {
			throw new Error(`Error getting profile data: \n ${JSON.stringify(profile, null, 4)}`)
		}
	}

	/**
	 * Create a pool and add it to local variable
	 * @param {Object} options
	 * @param {string} options.type - Pool algo, eg: sha256, scrypt, x11, etc
	 * @param {string} options.name - Name to identify the pool with
	 * @param {string} options.host - Pool host, the part after stratum+tcp://
	 * @param {number} options.port - Pool port, the part after the : in most pool host strings
	 * @param {string} options.user - Your workname
	 * @param {number} [options.id] - Local ID (NOT MRR ID)
	 * @param {string} [options.pass='x'] - Worker password
	 * @param {string} [options.notes] - Additional notes to help identify the pool for you
	 * @async
	 * @returns {Promise<Object>}
	 */
	async _createPool(options) {
		let pool = {};
		try {
			let res = await this.api.createPool(options)
			if (res.success) {
				pool = res.data
			}
		} catch (err) {
			throw new Error(`Failed to create pool: ${err}`)
		}
		pool = {mrrID: pool.id, name: options.name, host: options.host, port: options.port, id: options.id}
		this.addPools(pool)
		return pool
	}

	/**
	 * Delete pool from local variable, this.pools, and from the MRR website
	 * @param id
	 * @returns {Promise<Object>}
	 * @private
	 */
	async _deletePool(id) {
		let poolID;
		for (let pool in this.pools) {
			if (this.pools[pool].id === id) {
				poolID = this.pools[pool].mrrID
				this.pools.splice(pool, 1)
			}
		}

		try {
			return await this.api.deletePools(poolID)
		} catch (err) {
			throw new Error(`Failed to delete pool: ${err}`)
		}
	}

	/**
	 * Get all pools, a single pool by ID, or multiple pools by their IDs
	 * @param {(number|Array.<number>)} [ids] - can be a single pool id or multiple pool ids. If no ids are passed, will fetch all pools
	 * @return {Promise<Object>}
	 */
	async _getPools(ids) {
		if (!ids) {
			let res;
			try {
				res = await this.api.getPools()
			} catch (err) {
				throw new Error(`Could not fetch pools \n ${err}`)
			}
			if (res.success) {
				return res.data
			} else {
				throw new Error(`Success: false. ${res.data}`)
			}
		} else {
			let res
			try {
				res =  await this.api.getPoolsByID(ids)
			} catch (err) {
				throw new Error(`Could not fetch pools \n ${err}`)
			}
			if (res.success) {
				return res.data
			} else {
				throw new Error(`Success: false. ${res.data}`)
			}
		}
	}

	/**
	 * Creates a pool and adds it to a newly created pool profile
	 * @param {Object} options
	 * @param {string} options.profileName - Name of the profile
	 * @param {string} options.algo - Algorithm ('scrypt', 'x11', etc)
	 * @param {string} options.name - Name to identify the pool with
	 * @param {string} options.host - Pool host, the part after stratum+tcp://
	 * @param {number} options.port - Pool port, the part after the : in most pool host strings
	 * @param {string} options.user - Your workname
	 * @param {number} options.priority - 0-4
	 * @param {string} [options.pass] - Worker password
	 * @param {string} [options.notes] - Additional notes to help identify the pool for you
	 * @returns {Promise<Object>} - returns an object with the profileID and poolid on success
	 */
	async _createPoolProfile(options) {
		let poolProfile;
		try {
			let response = await this.api.createPoolProfile(options.profileName, options.algo)
			if (response.success) {
				poolProfile = response.data.id
			}
		} catch (err) {
			throw new Error(`Could not create Pool Profile \n ${err}`)
		}
		let pool;
		let poolParams = {};
		for (let opt in options) {
			if (opt === 'profileName') {
				poolParams.name = options[opt]
			} else if (opt === 'algo') {
				poolParams.type = options[opt]
			} else {
				poolParams[opt] = options[opt]
			}
		}
		try {
			let response = await this.api.createPool(poolParams)
			if (response.success) {
				pool = response.data.id
			}
		} catch (err) {
			throw new Error(`Could not create pool \n ${err}`)
		}

		let poolObject = {pool: poolParams}
		this.addPools(poolObject)

		let addPoolToProfileOptions = {
			profileID: poolProfile,
			poolid: pool,
			priority: options.priority,
			algo: options.algo,
			name: options.name
		};

		let success;
		try {
			let response = await this.api.addPoolToProfile(addPoolToProfileOptions)
			if (response.success) {
				success = response.data
			}
		} catch (err) {
			throw new Error(`Failed to add pool: ${pool} to profile: ${poolProfile} \n ${err}`)
		}
		let returnObject
		if (success.success) {
			returnObject = {
				profileID: success.id,
				poolid: pool,
				success: true,
				message: success.message
			}
		} else {
			returnObject = success
		}
		return returnObject
	}

	/**
	 * Set a pool profile to active
	 * pool profile id
	 */
	_setActivePool(profileID) {
		this.activePoolProfile = profileID
	}

	/**
	 * Set pool profiles to local variable, this.poolProfiles
	 * @param {Array.<Object>} profiles - an array of objects with the name and if of the pool profile
	 */
	setPoolProfiles(profiles) {
		this.poolProfiles = profiles
	}

	/**
	 * Get all pool profiles, a single pool profile by ID, or multiple pool profiles by their IDs
	 * @param {(number|Array.<number>)} [ids] - can be a single pool id or multiple pool ids. If no ids are passed, will fetch all pools
	 * @returns {Promise<Object>}
	 */
	async getPoolProfiles(ids) {
		if (!ids) {
			try {
				return await this.api.getPoolProfiles()
			} catch (err) {
				throw new Error(`Could not fetch pools \n ${err}`)
			}
		} else {
			try {
				return await this.api.getPoolProfile(ids)
			} catch (err) {
				throw new Error(`Could not fetch pools \n ${err}`)
			}
		}
	}

	/**
	 * Get the confirmed account balance for a specific coin (defaults to BTC)
	 * @param {string} [coin='BTC'] - The coin you wish to get a balance for [BTC, LTC, ETH, DASH]
	 * @returns {Promise<(number|Object)>} - will return an object if success is false ex. {success: false}
	 */
	async _getBalance(coin) {
		try {
			let response = await this.api.getAccountBalance()
			if (response.success) {
				if (coin) {
					return Number(response.data[coin.toUpperCase()].confirmed)
				} else {
					return Number(response.data['BTC'].confirmed)
				}
			} else {
				return {success: false}
			}
		} catch (err) {
			throw new Error(`Could not fetch account balance \n ${err}`)
		}
	}
	/**
	 * Get Back balances for all coins, confirmed and unconfirmed
	 * @returns {Promise<Object>}
	 */
	async _getBalances() {
		try {
			let response = await this.api.getAccountBalance()
			if (response.success) {
				return response.data
			} else {
				return {success: false}
			}
		}
		 catch (err) {
			throw new Error(`Could not fetch account balance \n ${err}`)
		}
	}
	/**
	 * Get the total cost to rent multiple rigs
	 * @param {Array.<Object>} rigs_to_rent - See MRRProvider.getRigsToRent()
	 * @returns {number}
	 */
	getRentalCost(rigs_to_rent) {
		let cost = 0
		for (let rig of rigs_to_rent) {
			//ToDo: make the crypto-currency dynamic
			cost += rig.btc_price
		}
		return cost
	}

	/**
	 * Get the total hashpower of an array of rigs to rent in megahash (mh)
	 * @param {Array.<Object>} rigs_to_rent - See MRRProvider.getRigsToRent()
	 * @returns {number}
	 */
	getTotalHashPower(rigs_to_rent) {
		let hashpower = 0
		for (let rig of rigs_to_rent) {
			hashpower += rig.hashrate
		}
		return hashpower
	}

	/**
	 * Rent rigs
	 * @param {Array.<Object>} rigs_to_rent - An array of rigs to rent (see AutoRenter.manualRentPreprocess)
	 * @returns {Promise<Object>}>}
	 */
	async rent(rigs_to_rent) {
		//rent rigs
		let rentalConfirmation = {};
		console.log(rigs_to_rent)
		for (let rig of rigs_to_rent) {
			try {
				let rental = await this.api.createRental(rig)
				rentalConfirmation[rig.rig] = rental
			} catch (err) {
				rentalConfirmation[rig.rig] = `Error renting rig: ${err}`
			}
		}

		let rented_rigs = []
		let spent_btc_amount = 0
		let total_rented_hashrate = 0

		for (let rig in rentalConfirmation){
			if (rentalConfirmation[rig].success){
				rented_rigs.push(rentalConfirmation[rig].data)
				spent_btc_amount += parseFloat(rentalConfirmation[rig].data.price.paid)
				total_rented_hashrate += rentalConfirmation[rig].data.hashrate.advertised.hash
			}
		}

		return {
			success: true,
			rented_rigs,
			btc_total_price: spent_btc_amount,
			total_hashrate: total_rented_hashrate
		}
	}

	/**
	 * Get the rigs needed to fulfill rental requirements
	 * @param {number} hashrate - in megahertz(mh)
	 * @param {number} duration - in hours
	 * @returns {Promise<Array.<Object>>}
	 */
	async getRigsToRent(hashrate, duration) {
		//get profileID
		let profileID
		try {
			profileID =  await this.getProfileID()
		} catch (err) {
			throw new Error(`Could not fetch profile ID \n ${err}`)
		}

		let rigOpts = {
			type: 'scrypt',
			minhours: {
				max: duration
			}
		}
		let rigsRequest;
		try {
			rigsRequest = await this.api.getRigs(rigOpts)
		} catch (err) {
			throw new Error(`Could not fetch rig list \n ${err}`)
		}
		let available_rigs = [];
		if (rigsRequest.success && rigsRequest.data) {
			if (rigsRequest.data.records.length === 0) {
				throw new Error(`No rigs found`)
			}
			let newRPIrigs = [], allOtherRigs = [];
			for (let rig of rigsRequest.data.records) {
				if (rig.rpi === 'new') {
					newRPIrigs.push(rig)
				} else {allOtherRigs.push(rig)}
			}
			allOtherRigs.sort((a,b) => {
				return (b.rpi - a.rpi)
			});
			available_rigs = newRPIrigs.concat(allOtherRigs)
		}

		if (hashrate >= 2000 && available_rigs.length < 15) {
			const calculateHashpower = (rigs) => {
				let total = 0;
				for (let rig of rigs) {
					total += rig.hashrate
				}
				return total
			}
			let filteredRigs = [];
			for (let rig of available_rigs) {
				filteredRigs.push({
					rental_info: {
						rig: parseInt(rig.id),
						length: duration,
						profile: parseInt(profileID)
					},
					hashrate: rig.hashrate.advertised.hash,
					btc_price: parseFloat(rig.price.BTC.hour) * duration
				})
			}
			if (calculateHashpower(filteredRigs) > hashrate) {
				return selectBestCombination(filteredRigs, hashrate, rig => rig.hashrate)
			}
		}

		let rigs_to_rent = [], hashpower = 0;
		for (let rig of available_rigs) {
			let rig_hashrate = rig.hashrate.advertised.hash
			if ((hashpower + rig_hashrate) <= hashrate) {
				hashpower += rig_hashrate

				rigs_to_rent.push({
					rental_info: {
						rig: parseInt(rig.id),
						length: duration,
						profile: parseInt(profileID)
					},
					hashrate: rig_hashrate,
					btc_price: parseFloat(rig.price.BTC.hour) * duration
				})
			}
		}
		return rigs_to_rent
	}
}

export default MRRProvider