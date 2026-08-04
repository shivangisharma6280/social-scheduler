import express  from "express";
import { addAccounts, disconnectAccounts, getAccounts } from "../controllers/accountControllers.js";
import { protect } from "../middleware/authMiddleware.js";



const accountRouter = express.Router();

accountRouter.get('/', protect, getAccounts);
accountRouter.post('/', protect, addAccounts);
accountRouter.get('/:id', protect, disconnectAccounts);

export default accountRouter;