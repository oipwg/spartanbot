import RentalProvider from "./RentalProvider";
import NiceHash from 'nicehash-api'

class NiceHashProvider extends RentalProvider {
	constructor(settings) {
		super(settings)

		this.api = new NiceHash(settings.key, settings.id)
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
	 * Test Authorization
	 * @async
	 * @returns {Promise<Boolean>}
	 */
	async testAuthorization(){
		try {
			return await this.api.testAuthorization()
		} catch(err) {
			throw new Error(`Authorization failed: ${err}`)
		}
	}
}

export default NiceHashProvider